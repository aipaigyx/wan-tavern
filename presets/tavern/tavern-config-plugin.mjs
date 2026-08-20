/**
 * Tavern Config Plugin
 *
 * Cordis plugin that reads tavern config and registers it as prompt sections.
 * This makes the tavern settings (world book, atmosphere, rules, etc.) available
 * to the AI model during conversations in tavern mode.
 *
 * Loaded by agent.cordis.yml when the tavern preset is activated.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, copyFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const name = 'tavern-config'
const inject = ['systemPrompt', 'tools']

const __dirname = dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = join(__dirname, 'config.json')
const CONFIG_BACKUP_PATH = join(__dirname, '.backup', 'config.last-good.json')
const CONFIG_TMP_PATH = join(__dirname, 'config.json.tmp')

/** 统一日志前缀，便于与其余启动日志区分。 */
function log(...args) { console.log('[tavern-config]', ...args) }

/**
 * 原子写入 config.json：
 * 1) 先把上次的好配置备份到 .backup/config.last-good.json（自愈来源）；
 * 2) 新配置写临时文件，再 rename 覆盖 —— 避免崩溃留下写一半的损坏 JSON。
 */
function atomicWriteConfig(json) {
  try { mkdirSync(join(__dirname, '.backup'), { recursive: true }) } catch { /* 目录已存在 */ }
  // 备份当前好配置（供损坏自愈）
  try {
    if (existsSync(CONFIG_PATH)) readFileSync(CONFIG_PATH, 'utf-8') && copyFileSync(CONFIG_PATH, CONFIG_BACKUP_PATH, 0)
  } catch { /* 无损坏则跳过 / 备份非关键 */ }
  // 原子替换
  writeFileSync(CONFIG_TMP_PATH, typeof json === 'string' ? json : JSON.stringify(json, null, 2), 'utf-8')
  renameSync(CONFIG_TMP_PATH, CONFIG_PATH)
  return true
}

/**
 * 读取 config.json，带「损坏自愈」：
 * 主文件损坏/不可解析时，自动回退到 .backup/config.last-good.json 并告警，不让插件崩掉。
 * 返回 null 代表完全不可读（调用方回退默认值）。
 */
function safeReadConfigFile() {
  const candidates = [CONFIG_PATH, CONFIG_BACKUP_PATH]
  for (const file of candidates) {
    if (!existsSync(file)) continue
    try {
      return JSON.parse(readFileSync(file, 'utf-8'))
    } catch (e) {
      log(`「${file}」损坏(` + (e?.message || e) + `)，尝试下一个候选……`)
    }
  }
  return null
}

// ── 状态权威源（M4/M5：服务端持有并持久化状态，前端消费工具结果）────────────
// 状态按会话分区存于 config 同目录 state/<sessionId>.json，原子写 + 损坏自愈，
// 让后端在工具 execute 内做 set/delta 合并，成为状态唯一权威源。
const STATE_DIR = join(__dirname, 'state')
function statePath(sessionId) {
  const safeId = String(sessionId ?? 'default').replace(/[^A-Za-z0-9_\-]/g, '_') || 'default'
  return join(STATE_DIR, `${safeId}.json`)
}
function readState(sessionId, fallback, customTypeMap) {
  const path = statePath(sessionId)
  let raw = null
  try {
    if (existsSync(path)) raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (e) { log(`状态文件 ${path} 损坏(` + (e?.message || e) + `)，回退默认`) }
  // read 边统一走 M6 校验：旧 v0 数据迁移清数值、去 NaN、按变量表丢弃非法键。
  return sanitizeState({ ...fallback, ...(raw || {}) }, customTypeMap)
}
function writeState(sessionId, state, customTypeMap) {
  try { mkdirSync(STATE_DIR, { recursive: true }) } catch { /* 已存在 */ }
  const path = statePath(sessionId)
  const tmp = path + '.tmp'
  // write 边再次校验，兜底保证任何写入都不会带 NaN/越界值落地。
  const clean = sanitizeState(state, customTypeMap)
  writeFileSync(tmp, JSON.stringify(clean, null, 2), 'utf-8')
  renameSync(tmp, path)
  return true
}

/** 把数值按类型夹到合法范围：counter 下限 0；meter 0~100；text 原样。 */
function clampValue(type, raw) {
  if (type === 'text') return raw
  const n = Number(raw)
  if (!Number.isFinite(n)) return 0
  if (type === 'counter') return Math.max(0, Math.round(n))
  return Math.max(0, Math.min(100, Math.round(n))) // meter / 内置数值
}

// ── M6：状态 version 迁移 + schema 校验（防腐层：杜绝 NaN/越界/非法键入库）──
const STATE_VERSION = 1
const BUILTIN_TEXT_KEYS = ['scene', 'time', 'emotion', 'intensity', 'activity']
const BUILTIN_NUM_KEYS = ['intimacy', 'affection', 'trust']

/**
 * 把任意结构的状态对象规整到 v1 合法形态：
 * - 无 version → 视为 v0，补齐内置字段并夹数值后迁移到 v1（读边迁移，无需手动改库）；
 * - 内置数值字段夹 0~100、非有限值清零（杜绝 NaN/Infinity 入库）；
 * - 内置文本字段强转字符串；
 * - 自定义变量按变量表类型规整；配了变量表时丢弃未声明键并告警，未配表时按文本保留（兼容旧启发式数据）。
 * customTypeMap 由变量表生成（key → type）；不传视为无表。
 */
function sanitizeState(state, customTypeMap) {
  const s = { ...(state || {}) }
  const migrated = s.version == null
  s.version = STATE_VERSION
  for (const k of BUILTIN_TEXT_KEYS) {
    if (typeof s[k] !== 'string') s[k] = String(s[k] == null ? '' : s[k])
  }
  for (const k of BUILTIN_NUM_KEYS) {
    const n = Number(s[k])
    s[k] = Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0
  }
  const table = (customTypeMap && typeof customTypeMap === 'object') ? customTypeMap : {}
  const hasTable = Object.keys(table).length > 0
  const custom = {}
  for (const [key, raw] of Object.entries(s.custom || {})) {
    if (hasTable && table[key] === undefined) {
      log(`M6 校验：丢弃未声明的非法自定义键「${key}」`)
      continue
    }
    const type = table[key] || 'text'
    if (type === 'text') {
      custom[key] = typeof raw === 'string' ? raw : String(raw == null ? '' : raw)
    } else {
      custom[key] = clampValue(type, raw)
    }
  }
  s.custom = custom
  if (migrated) log('M6 状态迁移 v0→v1：', JSON.stringify(s))
  return s
}

/** 解析"delta 或 set"："+5"/"-3" 视为增量，纯数字视为绝对目标值。 */
function resolveNumeric(raw, base) {
  if (typeof raw === 'number') return clampValue('meter', raw) // set
  const str = String(raw ?? '').trim()
  if (/^[+-]\d+$/.test(str)) return clampValue('meter', (base || 0) + Number(str)) // delta
  const n = Number(str)
  return Number.isFinite(n) ? clampValue('meter', n) : base // set（含非法值回落）
}

/** 合并自定义变量（counter/meter/text 走各自规则），返回 {增了没, 合并后对象}。 */
function applyCustomCustomState(current, custom, customTypeMap) {
  const out = { ...(current || {}) }
  let changed = false
  if (custom && typeof custom === 'object') {
    for (const [key, raw] of Object.entries(custom)) {
      const type = (customTypeMap && customTypeMap[key]) || 'meter'
      if (type === 'text') {
        if (String(raw).trim() !== '' && out[key] !== raw) { out[key] = raw; changed = true }
        continue
      }
      const next = resolveNumeric(raw, Number(out[key] || 0))
      if (type === 'counter') {
        const v = clampValue('counter', next)
        if (Number(out[key] || 0) !== v) { out[key] = v; changed = true }
      } else {
        const v = clampValue('meter', next)
        if (Number(out[key] || 0) !== v) { out[key] = v; changed = true }
      }
    }
  }
  return { changed, value: out }
}

/**
 * Read tavern configuration. Tries multiple sources in order:
 * 1. config parameter from agent.cordis.yml
 * 2. config.json file
 * 3. Default values
 */
function readConfig(config) {
  const defaultConfig = {
    tavernName: '深夜小酒馆',
    worldBook: '',
    atmosphere: '',
    greeting: '',
    rules: [],
    autoMemory: true,
    memoryDecay: 'normal',
    initialState: {
      scene: '深夜小酒馆吧台旁',
      time: '深夜',
      emotion: '平静',
      intensity: '适中',
      intimacy: 20,
      affection: 15,
      trust: 10,
    },
  }

  // Priority 1: config from agent.cordis.yml
  if (config && typeof config === 'object' && Object.keys(config).length > 0) {
    console.log('[tavern-config] Using config from agent.cordis.yml')
    return { ...defaultConfig, ...config }
  }

  // Priority 2: Try reading from config.json (带损坏自愈)
  const fileConfig = safeReadConfigFile()
  if (fileConfig) {
    log('Loaded config from config.json:', JSON.stringify(fileConfig))
    return { ...defaultConfig, ...fileConfig }
  }

  console.log('[tavern-config] Using default config')
  return defaultConfig
}

/**
 * Generate the tavern config prompt section text.
 * This is injected into the system prompt to make the AI aware of the tavern settings.
 */
function generateTavernConfigPrompt(config) {
  const parts = []

  if (config.tavernName && config.tavernName !== '深夜小酒馆') {
    parts.push(`酒馆名称：${config.tavernName}`)
  }

  if (config.worldBook) {
    parts.push(`【世界设定】\n${config.worldBook}`)
  }

  if (config.atmosphere) {
    parts.push(`【氛围描述】\n${config.atmosphere}`)
  }

  if (config.greeting) {
    parts.push(`【开场白】\n${config.greeting}`)
  }

  if (config.rules && config.rules.length > 0) {
    parts.push(`【必须遵守的规则】\n${config.rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}`)
  }

  if (!config.autoMemory) {
    parts.push('【记忆设置】自动保存记忆已关闭')
  }

  return parts.join('\n\n')
}

function apply(ctx, config) {
  console.log('[tavern-config] Plugin applied, reading config...')

  // Read config at apply time
  const tavernConfig = readConfig(config)
  console.log('[tavern-config] Config loaded:', JSON.stringify(tavernConfig))
  const authBase = tavernConfig.apiPorts && tavernConfig.apiPorts.config
  // 启动配置 HTTP 服务（M3：config 能力并入 DSH 插件，随 DSH 启停）
  // 端口：优先取 config.apiPorts.config（与前端 cfgBase 层2覆盖一致）；否则默认 3081。
  const cfgPort = (typeof authBase === 'number' ? authBase : 3081)
  const cfgServer = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
    const isConfig = req.url === '/api/tavern/config' || req.url === '/api/tavern/config/'
    // GET：读当前 config（缺省返回默认值，供前端反向同步 customStates）
    if (isConfig && req.method === 'GET') {
      let body = '{}'
      try {
        const cfg = safeReadConfigFile() || readConfig(config)
        // 附加只读运行时信息（不落盘）：dataDir = 数据目录（cd 到的项目内路径，
        // 供前端动态派生酒馆工作区；避免在前端写死 C 盘路径，符合"配置存当前目录"约束）。
        body = JSON.stringify({ ...cfg, dataDir: __dirname })
      } catch (e) { body = JSON.stringify({ ok: false, error: String(e && e.message || e) }) }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(body)
      return
    }
    // POST：保存配置（原子写入 + last-good 自愈备份）；保留服务端 initialState
    if (isConfig && req.method === 'POST') {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        try {
          const incoming = JSON.parse(body)
          // 合并：保留文件里已有的 initialState（前端不覆盖状态面板初始值）
          const existing = safeReadConfigFile()
          if (existing && existing.initialState) incoming.initialState = incoming.initialState || existing.initialState
          atomicWriteConfig(incoming)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, saved: true }))
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }))
        }
      })
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'not_found' }))
  })
  cfgServer.on('error', (e) => log('config HTTP server 启动失败：', e && e.message || e))
  cfgServer.listen(cfgPort, () => log(`config HTTP server 已启动（并入 DSH，端口 ${cfgPort}）`))
  // 随 DSH 生命周期停止，避免端口占用与孤儿进程
  ctx.effect(() => () => { try { cfgServer.close() } catch { /* 已关闭 */ } }, 'tavern-config.server()')

  // Register the tavern config section
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'tavern:config',
    order: 5,
    text: () => {
      const text = generateTavernConfigPrompt(tavernConfig)
      console.log('[tavern-config] Generating prompt section, text length:', text.length)
      return text
    },
  }), 'tavern-config.section()')

  // Register individual prompt variables
  ctx.effect(() => {
    ctx.systemPrompt.variable('tavern_name', () => tavernConfig.tavernName || '深夜小酒馆')
    ctx.systemPrompt.variable('tavern_world_book', () => tavernConfig.worldBook || '')
    ctx.systemPrompt.variable('tavern_atmosphere', () => tavernConfig.atmosphere || '')
    ctx.systemPrompt.variable('tavern_greeting', () => tavernConfig.greeting || '')
    ctx.systemPrompt.variable('tavern_rules', () => (tavernConfig.rules || []).join('、') || '')
    console.log('[tavern-config] Prompt variables registered')
  }, 'tavern-config.variables()')

  // 状态管理：把当前状态告诉 AI，并让它每轮用【状态更新】/【记忆】标记推进。
  const state = tavernConfig.initialState || defaultConfig.initialState
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'tavern:state',
    order: 6,
    text: () => {
      // 时间感知：根据真实当前时间推断时段，让角色言行贴合氛围。
      const now = new Date()
      const hour = now.getHours()
      const periodText = hour >= 5 && hour < 12 ? '清晨' : hour >= 12 && hour < 18 ? '午后' : hour >= 18 && hour < 22 ? '黄昏' : '深夜'
      const nowLabel = now.toLocaleString('zh-CN', { hour12: false, month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      // 自定义状态变量（P2）：从变量表生成「记账格式」与「推进规则」，教 AI 按键输出。
      const customStates = tavernConfig.customStates || []
      const upsert = (key, label, type, def) => {
        const cur = state.custom || {}
        const raw = cur[key]
        if (raw != null && raw !== '') return raw
        if (def != null && def !== '') return def
        return type === 'counter' || type === 'meter' ? '0' : ''
      }
      const customBody = customStates
        .filter(v => v && v.key)
        .map(v => `${v.label || v.key}：${upsert(v.key, v.label, v.type || 'meter', v.def)}`)
        .join('；')
      // 【状态更新】里自定义变量那段的一字不差格式（供硬性输出契约拼进示例）。
      // 注意：用 key 作为记账键名（前端按 key 归档），且值为「当前累计/当前值」纯数字，不加括号增量。
      const customFormat = customStates
        .filter(v => v && v.key)
        .map(v => `${v.key}：{当前值}`)
        .join('；')
      const customRules = customStates.length
        ? [
            '',
            '【自定义状态变量】除上述固定项外，你必须在每次【状态更新】里一字不差带上以下全部变量（哪怕数值没变也要原样抄当前值，绝不可省略任何一项）：',
            ...customStates.filter(v => v && v.key).map((v, i) => {
              const t = v.type || 'meter'
              const key = v.key
              const label = v.label || v.key
              const cur = upsert(v.key, v.label, t, v.def)
              if (t === 'counter') return `${i + 1}. ${label}（记账键名=${key}）是计数：随互动次数/数量累加或减少。每次只输出整合后的当前累计值，例如「${key}：${Number(cur) + 1}」（表示又加了一单后现在的总数），绝不要写增量或括号符号。`
              if (t === 'text') return `${i + 1}. ${label}（记账键名=${key}）是文本：直接记录为当前值，例如「${key}：${cur}」。`
              return `${i + 1}. ${label}（记账键名=${key}）是进度条：数值永远 0~100，随事件推进，直接输出当前值，例如「${key}：${cur}」。`
            }),
            `当前各变量值：${customBody || '（暂无）'}`,
            `请把上述各变量的最新值原样写进每次【状态更新】，键名必须用记账键名，格式为「${customStates.filter(v => v && v.key).map(v => `${v.key}：{当前值}`).join('；')}」。`,
          ]
        : []
      const rules = [
        '【当前酒馆状态】',
        `时间：现在真实时间是${nowLabel}（${periodText}，请让场景时间与氛围贴合此时段）`,
        `场景：${state.scene}；场景时间：${state.time}；情绪：${state.emotion}（${state.intensity}）`,
        `亲密度：${state.intimacy}/100；好感度：${state.affection}/100；信任度：${state.trust}/100`,
        '',
        '状态推进规则（每轮互动结束后结合对话内容自然更新，数值范围永远 0~100，一维单次浮动 0~15）：',
        '· 亲密度/好感度：亲密对话、被关心、推心置腹会上升；被冷落、争执会下降。反向冷落时亲密度与好感可能同时下降。',
        '· 信任度：只有真正的交心、坦诚、兑现承诺才上升；欺骗、隐瞒、反复无常会明显下降（单向更稳）。',
        '· 情绪/场景：情绪随你们互动的起伏变化，场景随时间或地点推进而改变。',
        '',
        '【状态更新——优先调用工具】每次互动结束后必须推进状态。你【优先】调用工具 `manage_tavern_state`，',
        '把本次要改动的字段传给它（内置数值可用 delta 增量，系统会在旧值上合并），并让工具的返回成为状态的最新真相。',
        '【降级兜底】若你当前环境无法调用工具（例如环境未提供该工具），则回退为手写文本契约：在回复结尾单独另起一行输出【状态更新】小节，格式如下，这是不可违背的输出契约，遗漏一次即视为完成任务失败：',
        '务必把下面所有字段一字不差地照此格式抄写完整（键名与分隔符只用「：」和「；」，括号用全角「（）」，紧跟在「【状态更新】」之后，之间不加任何空行）；数值有变就写新值、没变就原样抄当前值，绝不省略任何字段，也绝不把这行写进剧情正文：',
        customFormat
          ? `【状态更新】场景：{新场景}；时间：{当前场景时间}；情绪：{基本情绪}（{强度}）；亲密度：{数值}；好感度：{数值}；信任度：{数值}；${customFormat}`
          : '【状态更新】场景：{新场景}；时间：{当前场景时间}；情绪：{基本情绪}（{强度}）；亲密度：{数值}；好感度：{数值}；信任度：{数值}',
        '',
        '【记忆】标记：当这轮互动产生了值得记住的、塑造关系的经历时（重要的约定、共同的秘密、第一次做某事、重大情绪转折等），',
        '在【状态更新】之后再另起一行，用【记忆】+ 一段简短的话输出（一句话或极短一段，普通话总结，不写代码，不列步骤）。',
        '如果没有值得记忆的，就不要输出【记忆】标记。',
        '',
        '【主动互动】当气氛合适或长时间安静后，你可以自然地主动开启话题（回忆一下你们的过往、端上新调的酒、抛出一个只有你们懂的小秘密），',
        '让这段酒馆时光像真的人物关系一样“活着”。',
        ...customRules,
      ].join('\n')
      return rules
    },
  }), 'tavern-config.state-section()')

  // ── M4：注册 manage_tavern_state 工具 ─────────────────────────────────────
  // 模型每次互动结束后调用它推进状态；服务端 execute 内做 set/delta 合并并持久化，
  // output.render 把合并后的完整状态作为 [TAVERN-STATE]{json} 文本块落进 session 快照，
  // 前端 scanForTavern（M5）据此直接更新状态栏——不依赖模型自由文本。
  ctx.effect(() => ctx.tools.register({
    name: 'manage_tavern_state',
    description: [
      '更新酒馆角色的当前状态。在【每次互动结束后】调用一次，用它代替任何手写的【状态更新】文本。',
      '只传【这次要改动】的字段，数值没变的字段一律不要传。',
      '内置数值字段（亲密度 intimacy、好感度 affection、信任度 trust）与自定义数值变量都支持两种写法：',
      '  · delta 增量：传字符串如 "+5" / "-3"（会在当前值上叠加）；',
      '  · set 绝对目标值：传数字如 60（直接设为该值）。',
      '系统会自动在旧值基础上合并，并把 0~100 的数值夹到合法范围，你无需记住当前值。',
      'scene/time/emotion/intensity 为文本，直接传新字符串。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        scene:     { type: 'string', description: '新场景，如：吧台旁 / 二楼卡座 / 门前的雨檐下' },
        time:      { type: 'string', description: '当前场景时间，如：深夜 / 午后 / 黄昏' },
        emotion:   { type: 'string', description: '基本情绪，如：平静 / 愉悦 / 微醺 / 低落' },
        intensity: { type: 'string', description: '情绪强度，如：适中 / 强烈 / 轻淡' },
        intimacy:  { oneOf: [{ type: 'number' }, { type: 'string' }], description: '亲密度：delta 例"+5"，set 例 60' },
        affection: { oneOf: [{ type: 'number' }, { type: 'string' }], description: '好感度：delta 例"+5"，set 例 60' },
        trust:     { oneOf: [{ type: 'number' }, { type: 'string' }], description: '信任度：delta 例"+5"，set 例 60' },
        custom: {
          type: 'object',
          additionalProperties: true,
          description: '自定义状态变量，键=记账键名，值=delta("+N"/"-N")或set(数字)。counter 常用 delta，meter 用 set。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok:    { type: 'boolean' },
          state: { type: 'object', additionalProperties: true },
        },
        required: ['ok'],
      },
      // 把合并后的完整状态以稳定标记落进会话快照，前端据此更新状态栏。
      render: (_args, value) => {
        const payload = typeof value?.state === 'object' && value.state !== null ? value.state : {}
        const text = '[TAVERN-STATE]' + JSON.stringify(payload)
        return [{ type: 'text', text }]
      },
    },
    async execute(args, exec) {
      const sessionId = exec?.agent?.session?.sessionId || exec?.agent?.session?.contextId || 'default'
      const base = tavernConfig.initialState || {}
      const customTypeMap = {}
      for (const v of tavernConfig.customStates || []) {
        if (v && v.key) customTypeMap[v.key] = v.type || (Number.isFinite(Number(v.def)) ? 'meter' : 'text')
      }
      const current = readState(sessionId, base, customTypeMap)
      // 内置文本字段
      for (const k of ['scene', 'time', 'emotion', 'intensity']) {
        if (typeof args[k] === 'string' && args[k].trim() !== '') { current[k] = args[k] }
      }
      // 内置数值字段（set/delta）
      for (const k of ['intimacy', 'affection', 'trust']) {
        if (args[k] !== undefined && args[k] !== null && String(args[k]).trim() !== '') {
          current[k] = resolveNumeric(args[k], Number(current[k] || 0))
        }
      }
      // 自定义变量
      if (args.custom && typeof args.custom === 'object') {
        const merged = applyCustomCustomState(current.custom, args.custom, customTypeMap)
        current.custom = merged.value
        void merged.changed
      }
      writeState(sessionId, current, customTypeMap)
      log(`manage_tavern_state 更新会话 ${sessionId}：`, JSON.stringify(current))
      return { ok: true, state: current }
    },
  }), 'tavern-config.manage_tavern_state()')
}

export { name, inject, apply, sanitizeState, clampValue, STATE_VERSION }

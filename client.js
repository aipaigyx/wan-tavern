// dsh-tavern browser half: self-contained 酒馆模式 plugin.
// Provides: (1) sidebar bottom 酒馆 entry, (2) tavern chat header card,
// (3) 酒馆设置 settings section. No modifications to DSH native code.
window.__ModuleLoader__.load({
  id: 'dsh-tavern',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const { useState, useEffect, useCallback, useRef } = React

    // ── 地址解析（M2：四层探测链，替代硬编码端口）──────────────────────
    // 用途：把写死的 18766 / 3081 改为运行时推导，避免改 DSH 端口就崩。
    // 层级优先级：1) DSH 注入基址  2) 用户设置覆盖  3) 同源推导  4) 兜底默认。
    // 注意：此函数在模块初始化后被调用（fetch 时机），因此可安全引用后置的
    // loadTavernConfig（调用时它已初始化，不存在 TDZ 问题）。
    function dshPort(which, fallback) {
      try {
        // 层1：DSH 运行时注入（若宿主把各服务端口写进 __DSH_BOOT__）
        const boot = window.__DSH_BOOT__
        if (boot && boot.services && typeof boot.services[which] === 'number') return boot.services[which]
        if (boot && typeof boot[`${which}Port`] === 'number') return boot[`${which}Port`]
      } catch {}
      try {
        // 层2：用户设置覆盖（config.apiPorts.{api|config}，可在 config.json 预置）
        const cfg = loadTavernConfig() || {}
        const p = (cfg.apiPorts || {})[which]
        if (typeof p === 'number') return p
      } catch {}
      // 层3：已移除同源推导 —— config 服务由 DSH 插件在独立端口(3081)启动，
      // 与 DSH 主端口(3080)不同源，同源推导会返回错误端口。直接走兜底。
      // 层4：兜底默认
      return fallback
    }
    // 各服务基址（运行时推导，用作 API 拼装）
    function apiBase() { return 'http://127.0.0.1:' + dshPort('api', 18766) + '/api/persona' }
    function memApiBase() { return 'http://127.0.0.1:' + dshPort('api', 18766) + '/api/memory' }
    function cfgBase() { return 'http://127.0.0.1:' + dshPort('config', 3081) }

    // 诊断用：描述各端口最终解析到了哪一层（M2 四层探测链的层序号）。
    function describeProbe() {
      const boot = (typeof window !== 'undefined' && window.__DSH_BOOT__) || null
      const apiP = dshPort('api', 18766)
      const cfgP = dshPort('config', 3081)
      // 层判定（与 dshPort 内部逻辑一致）
      const apiLayer = (boot && boot.services && typeof boot.services.api === 'number') ? 1
        : ((loadTavernConfig() || {}).apiPorts || {}).api !== undefined ? 2 : 4
      const cfgLayer = (boot && boot.services && typeof boot.services.config === 'number') ? 1
        : ((loadTavernConfig() || {}).apiPorts || {}).config !== undefined ? 2
        : (typeof window !== 'undefined' && window.location && window.location.port) ? 3 : 4
      return `api=${apiP}(层${apiLayer}) · config=${cfgP}(层${cfgLayer})`
    }

    async function api(path, method = 'GET', body) {
      try {
        const opts = { method, signal: AbortSignal.timeout(5000) }
        if (body) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body) }
        const res = await fetch(`${apiBase()}${path}`, opts)
        return res.ok ? await res.json() : { ok: false, error: 'http_error' }
      } catch { return { ok: false, error: 'connection_refused' } }
    }

    async function memApi(personaId, path, method = 'GET', body) {
      try {
        let url = `${memApiBase()}${path}`
        if (method === 'GET' && personaId) {
          url += (path.includes('?') ? '&' : '?') + `personaId=${encodeURIComponent(personaId)}`
        }
        const opts = { method, signal: AbortSignal.timeout(5000) }
        if (body) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify({ personaId, ...body }) }
        const res = await fetch(url, opts)
        return res.ok ? await res.json() : { ok: false, error: 'http_error' }
      } catch { return { ok: false, error: 'connection_refused' } }
    }

    // ── 状态面板(场景/情绪/亲密度) ─────────────────────────────────────────
    // AI 在回复中嵌入【状态更新】标记来推进状态；前端从会话快照里找出最新的
    // 助手回复、解析标记、合并并持久化到 localStorage，实时刷新面板。

    const TAVERN_STATE_KEY = 'dsh.tavern.state.v1'
    const TAVERN_COLLAPSE_KEY = 'dsh.tavern.collapsed'
    const DEFAULT_STATE = { scene: '深夜小酒馆吧台旁', time: '深夜', emotion: '平静', intensity: '适中', intimacy: 20, affection: 15, trust: 10, custom: {} }
    const DEFAULT_CUSTOM_STATES = [
      { key: '接客数', label: '接客', type: 'counter', def: '0' },
      { key: '兴奋度', label: '兴奋', type: 'meter', def: '' },
    ]

    // 状态按「老板（personaId）」分区存储，不同角色拥有各自独立的状态进度，
    // 避免切换老板后串用上一位的亲密度/信任/场景。
    const stateKey = (pid) => (pid ? `${TAVERN_STATE_KEY}:${pid}` : TAVERN_STATE_KEY)

    // ── M6：client 侧状态 version + schema 规整（与插件 sanitizeState 口径一致）──
    const TAVERN_STATE_VERSION = 1
    const CLIENT_NUM_KEYS = ['intimacy', 'affection', 'trust']
    const CLIENT_TEXT_KEYS = ['scene', 'time', 'emotion', 'intensity', 'activity']
    // 旧 v0 localStorage 数据：补 version、内置数值夹 0~100、文本强转字符串，杜绝 NaN 展示/入库。
    function normalizeClientState(s) {
      const out = { ...(s || {}) }
      out.version = TAVERN_STATE_VERSION
      for (const k of CLIENT_TEXT_KEYS) {
        if (typeof out[k] !== 'string') out[k] = String(out[k] == null ? '' : out[k])
      }
      for (const k of CLIENT_NUM_KEYS) {
        const n = Number(out[k])
        out[k] = Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0
      }
      return out
    }

    const loadTavernState = (pid) => {
      try {
        const raw = localStorage.getItem(stateKey(pid))
        if (raw) {
          const parsed = JSON.parse(raw)
          console.log('[tavern] loadTavernState pid=', pid, 'parsed.custom=', parsed.custom)
          return normalizeClientState({ ...DEFAULT_STATE, ...parsed })
        }
      } catch { /* ignore */ }
      return normalizeClientState({ ...DEFAULT_STATE })
    }
    const saveTavernState = (pid, s) => {
      const norm = normalizeClientState(s)
      console.log('[tavern] saveTavernState pid=', pid, 'norm.custom=', norm.custom)
      try { localStorage.setItem(stateKey(pid), JSON.stringify(norm)); return true } catch { return false }
    }

    // ── 自定义状态变量 ───────────────────────────────────────────────
    // 固定键走原有逻辑；其余【状态更新】键按值启发式归类进 custom：
    // meter=进度条(纯数字 0~100)、counter=累加计数(键含 次/杯/度/个/位/ml/钱 或以 + 开头)、
    // text=直接覆盖。不配置变量表也能用；P1 接入变量表后按表类型更可控。
    const FIXED_KEYS = new Set(['场景', '时间', '情绪', '亲密度', '好感度', '信任度', '活动'])
    function classifyCustom(key, value) {
      const raw = String(value == null ? '' : value).trim()
      const numM = raw.match(/([+-]?\d+(?:\.\d+)?)/)
      const plus = raw.startsWith('+')
      const isNum = !!numM && !/[^0-9+.\s]/.test(raw)
      if (plus || /次|杯|度|个|位|ml|钱/.test(key)) return { type: 'counter', num: numM ? Number(numM[1]) : 0, plus }
      if (isNum && numM) return { type: 'meter', num: Number(numM[1]) }
      return { type: 'text', raw }
    }

    // ── 繁体 → 简体 归一化 ─────────────────────────────────────────────
    // AI 可能用繁体输出【狀態更新】/自定变量键名，而前端判据与 config key 都是简体。
    // 解析前先把标记与键名出现的繁体字转成简体，保证能命中。
    const T2S = {
      '狀': '状', '態': '态', '場': '场', '時': '时', '間': '间', '緒': '绪',
      '親': '亲', '數': '数', '興': '兴', '奮': '奋', '記': '记', '憶': '忆',
      '動': '动', '單': '单', '裡': '里', '這': '这', '來': '来', '個': '个',
      '後': '后', '讓': '让', '與': '与', '們': '们', '點': '点', '關': '关',
      '應': '应', '隻': '只', '麼': '么', '為': '为', '對': '对', '聲': '声',
      '儲': '储', '顯': '显', '無': '无', '戲': '戏', '樂': '乐', '話': '话',
      '說': '说', '達': '达', '銀': '银', '間': '间', '鈔': '钞', '錢': '钱',
    }
    const T2S_RE = new RegExp('[' + Object.keys(T2S).join('') + ']', 'g')
    function toSimplified(s) {
      if (!s) return s
      return String(s).replace(T2S_RE, ch => T2S[ch] || ch)
    }

    // 从文本里提取【状态更新】块；找不到返回 null。
    function extractStateUpdate(text) {
      if (!text || typeof text !== 'string') return null
      text = toSimplified(text)
      const m = text.match(/【状态更新】([\s\S]*?)(?:【|$)/)
      if (!m) return null
      const body = m[1]
      const next = {}
      for (const m of body.matchAll(/([^；;：:]+?)\s*[：:]\s*([^；;\n]+)/g)) {
        const key = (m[1] || '').trim()
        if (key) next[key] = (m[2] || '').trim()
      }
      if (Object.keys(next).length === 0) return null
      return next
    }

    // 从【状态更新】里取一个 0~100 数值，匹配不到返回 fallback。
    // 取第一个数字作为主值，兼容“28 / 28（+5）/ 28→32 / 好感度28”等写法，避免把增量误当最终值。
    function parseNum(value, fallback = 0) {
      const r = String(value == null ? '' : value).match(/\d+/g)
      if (!r || !r.length) return fallback
      const n = Number(r[0])
      return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : fallback
    }

    // 从【记忆】标记里提取要写入记忆系统的文本；找不到返回空串。
    function extractMemory(text) {
      if (!text || typeof text !== 'string') return ''
      text = toSimplified(text)
      const m = text.match(/【记忆】([\s\S]*?)(?:【|$)/)
      if (!m) return ''
      return m[1].replace(/\s+/g, ' ').trim()
    }

    // 亲密度 → 关系阶段。
    function stageOf(intimacy) {
      const i = parseInt(intimacy, 10) || 0
      if (i >= 90) return { label: '生死之交', color: '#f0a6c8' }
      if (i >= 70) return { label: '亲密知己', color: '#e0a96e' }
      if (i >= 45) return { label: '熟识老友', color: '#8ecb6b' }
      if (i >= 25) return { label: '常来客', color: '#7dd3fc' }
      if (i >= 10) return { label: '生面孔', color: '#b0a490' }
      return { label: '初来乍到', color: '#a89a8c' }
    }

    // 情绪/强度 → 氛围主题（背景渐变、高亮色、氛围词）。
    function emotionTheme(emotion, intensity) {
      const e = String(emotion || '')
      let theme = { bg: 'linear-gradient(180deg, #2a2320, #1d1816)', glow: '#d8b98a', word: '暖黄灯下' }
      if (/温柔|愉悦|温馨|甜蜜|开心|自在/.test(e)) theme = { bg: 'linear-gradient(180deg, #2a2a23, #201d18)', glow: '#e8c46a', word: '暖融融的星光' }
      else if (/热烈|兴奋|亢奋|激动|高涨|开心|愉悦/.test(e)) theme = { bg: 'linear-gradient(180deg, #3a2420, #241915)', glow: '#f0a06a', word: '摇曳的炉火' }
      else if (/愤怒|烦躁|争吵|尖酸|冷酷/.test(e)) theme = { bg: 'linear-gradient(180deg, #33201f, #241818)', glow: '#e0706a', word: '紧绷的气氛' }
      else if (/难过|委屈|低沉|失落|悲伤/.test(e)) theme = { bg: 'linear-gradient(180deg, #20242e, #181b22)', glow: '#7c9bd6', word: '清冷的月光' }
      else if (/紧张|羞涩|慌乱|尴尬/.test(e)) theme = { bg: 'linear-gradient(180deg, #2b2330, #1d1922)', glow: '#b88ad6', word: '欲言又止' }
      return theme
    }

    // 情绪 → 角色的表情 emoji 与动作（无立绘下用字符呈现"看到角色状态"）。
    function emotionFace(emotion) {
      const e = String(emotion || '')
      if (/温柔|愉悦|温馨|甜蜜|自在|开心/.test(e)) return { emoji: '😌', act: '眉眼含笑，把杯子轻轻推向你' }
      if (/亢奋|热烈|兴奋|挑逗|高涨|激动/.test(e)) return { emoji: '😏', act: '倾身贴近吧台，直勾勾盯着你' }
      if (/愤怒|尖酸|烦躁|争吵|冷酷/.test(e)) return { emoji: '😤', act: '把酒杯往吧台一磕，似笑非笑' }
      if (/难过|委屈|低沉|失落|悲伤/.test(e)) return { emoji: '😔', act: '指尖在杯沿划着圈，低着头没看你' }
      if (/紧张|羞涩|慌乱|尴尬/.test(e)) return { emoji: '😳', act: '耳根泛红，悄悄别开视线' }
      return { emoji: '🍷', act: '不紧不慢地替你添满杯里的酒' }
    }

    // 情绪 → 立绘文件名 key（与 persona 系统 PORTRAIT_EMOTIONS.key 对应），
    // 状态面板按它从 persona API 加载对应情绪的角色立绘。
    function portraitKey(emotion) {
      const e = String(emotion || '')
      if (/温柔|温馨/.test(e)) return 'warm'
      if (/愉悦|开心|甜蜜|自在|高兴|雀跃/.test(e)) return 'joy'
      if (/挑逗|亢奋|热烈|兴奋|高涨|激动|调皮/.test(e)) return 'tease'
      if (/愤怒|尖酸|烦躁|争吵|冷酷|恼/.test(e)) return 'angry'
      if (/难过|委屈|低沉|失落|悲伤|惆怅/.test(e)) return 'sad'
      if (/紧张|羞涩|慌乱|尴尬|脸红/.test(e)) return 'shy'
      return 'neutral'
    }

    // 立绘呼吸动效：注入一次全局 keyframes，缩略图以此轻微缩放产生"活"感。
    // M7 追加：数值变化高亮（tavernRefreshGlow）、回合变化提示淡入淡出（tavernTurnIn）、记忆卡 hover 抬升。
    if (!window.__tavernBreathInjected__ && typeof document !== 'undefined') {
      window.__tavernBreathInjected__ = true
      const st = document.createElement('style')
      st.textContent = [
        '@keyframes tavernBreath{0%,100%{transform:scale(1)}50%{transform:scale(1.05)}}',
        '@keyframes tavernRefreshGlow{0%{opacity:.35;color:#fff6e0;text-shadow:0 0 10px #ffd98a}60%{opacity:1}100%{opacity:1}}',
        '@keyframes tavernTurnIn{0%{opacity:0;transform:translateY(-6px)}12%{opacity:1;transform:translateY(0)}78%{opacity:1}100%{opacity:0}}',
        '.tavMemCard{transition:transform .18s ease, box-shadow .18s ease, border-color .18s ease}',
        '.tavMemCard:hover{transform:translateY(-2px); box-shadow:0 8px 22px rgba(0,0,0,0.28); border-color:#ffd98a55}',
      ].join('\n')
      document.head.appendChild(st)
    }

    // ── 聊天流标记隐藏器 ────────────────────────────────────────────────
    // AI 会用【状态更新】/【记忆】段落输出状态与记忆标记（供状态栏/记忆系统消费），
    // 这些标记不该出现在聊天气泡里。用 MutationObserver 在 DOM 层拦截并隐藏，
    // 完全不动 DSH 核心渲染；且受 tavernMarker.shouldHide 门控（仅酒馆会话启用），
    // 普通会话不误伤。
    const tavernMarker = { enabled: false, obs: null, hide: null }
    function ensureMarkerHider() {
      if (tavernMarker.obs || typeof document === 'undefined' || !document.body) return
      tavernMarker.hide = () => {
        if (!tavernMarker.enabled) return
        document.querySelectorAll('p').forEach(p => {
          const t = toSimplified((p.textContent || '').replace(/^\s+/, ''))
          if (t.startsWith('【状态更新】') || t.startsWith('【记忆】') || t.indexOf(TOOL_STATE_MARKER) >= 0) p.style.display = 'none'
        })
      }
      tavernMarker.obs = new MutationObserver(() => tavernMarker.hide())
      tavernMarker.obs.observe(document.body, { childList: true, subtree: true, characterData: true })
      tavernMarker.hide()
    }

    // 真实当前时段（让时间感"流动"起来）。
    function nowPeriod() {
      const h = new Date().getHours()
      if (h >= 5 && h < 12) return '清晨'
      if (h >= 12 && h < 18) return '午后'
      if (h >= 18 && h < 22) return '黄昏'
      return '深夜'
    }

    // 合并一道状态更新并持久化。
    function mergeState(prev, upd) {
      const s = { ...prev }
      if (upd['场景']) s.scene = upd['场景']
      if (upd['时间']) s.time = upd['时间']
      if (upd['情绪']) {
        const em = String(upd['情绪'])
        const im = em.match(/(自在|平静|温柔|愉悦|紧张|羞涩|低沉|难过|热烈|愤怒|兴奋|亢奋)/)
        const it = em.match(/(高涨|偏低|低落|强烈|适中|轻微)/)
        s.emotion = im ? im[1] : em
        s.intensity = it ? it[1] : '适中'
      }
      s.intimacy = parseNum(upd['亲密度'], s.intimacy)
      s.affection = parseNum(upd['好感度'], s.affection)
      s.trust = parseNum(upd['信任度'], s.trust)
      if (upd['活动']) s.activity = upd['活动']
      // 自定义键：优先按「变量表类型」合并（counter=累加计数、meter=夹 0~100、text=直接覆盖），
      // 表中没声明该键时才回退到启发式 classifyCustom。
      const cur = { ...(s.custom || {}) }
      let changed = false
      // 定表：key 与 label 都要能命中（AI 可能用 label 记账）。守到 key 为准，label 作别名。
      const defs = {}
      try {
        const cfg = loadTavernConfig() || {}
        for (const v of (cfg.customStates || [])) {
          if (!v || !v.key) continue
          defs[v.key] = { key: v.key, type: v.type }
          if (v.label && v.label !== v.key) defs[v.label] = { key: v.key, type: v.type }
        }
      } catch { /* 忽略 */ }
      // 规整后的对象：把 label 别名统一成 key。
      const norm = {}
      for (const k of Object.keys(upd)) {
        const ck = defs[k] ? defs[k].key : k
        if (FIXED_KEYS.has(ck)) continue
        norm[ck] = upd[k]
      }
      for (const [storeKey, rawVal] of Object.entries(norm)) {
        const raw = String(rawVal == null ? '' : rawVal).trim()
        const declaredType = defs[storeKey] ? defs[storeKey].type : null
        if (declaredType === 'counter') {
          // 计数。口径：带显式 + / - 前缀 → 相对累加；否则（含「N（+2）」括号写法）采信主值为当前累计。
          const m = raw.match(/([+-]?\d+)/)
          if (m) {
            const n = Number(m[1])
            const base = Number(cur[storeKey]) || 0
            const signed = /^\s*[+-]/.test(raw)
            cur[storeKey] = String(Math.max(0, signed ? base + n : Math.max(0, n)))
          } else {
            cur[storeKey] = String(Math.max(0, Number(cur[storeKey]) || 0))
          }
        } else if (declaredType === 'meter') {
          cur[storeKey] = String(Math.max(0, Math.min(100, Number(raw.replace(/[^\d.-]/g, '')) || 0)))
        } else if (declaredType === 'text') {
          cur[storeKey] = raw
        } else {
          // 未声明：回退启发式。
          const c = classifyCustom(storeKey, raw)
          if (c.type === 'counter') {
            const base = Number(cur[storeKey])
            cur[storeKey] = String(Math.max(0, (c.num < 0 ? base + c.num : (c.plus ? base + c.num : Math.max(0, c.num)))))
          } else if (c.type === 'meter') {
            cur[storeKey] = String(Math.max(0, Math.min(100, c.num)))
          } else {
            cur[storeKey] = c.raw
          }
        }
        changed = true
      }
      if (changed) s.custom = cur
      return s
    }

    // 自动驱动：把"增量"合并进状态（情绪/活动直接替换，数值按增量累加并夹在 0~100）。
    function mergeAuto(prev, d) {
      const s = { ...prev }
      if (d.emotion) s.emotion = d.emotion
      if (d.intensity) s.intensity = d.intensity
      if (d.activity) s.activity = d.activity
      if (d.intimacy) s.intimacy = Math.max(0, Math.min(100, (prev.intimacy || 0) + d.intimacy))
      if (d.affection) s.affection = Math.max(0, Math.min(100, (prev.affection || 0) + d.affection))
      if (d.trust) s.trust = Math.max(0, Math.min(100, (prev.trust || 0) + d.trust))
      return s
    }

    // 依用户说的内容，推断老板娘"此刻"的即时反应。命中返回增量，否则返回 null。
    // 这让状态随每一句对话即时流动，而不是等 AI 每轮都记得写【状态更新】标记。
    function sentimentDelta(text) {
      const t = String(text || '')
      if (/想你|喜欢你|爱你|喜欢|亲爱的|心疼|陪着你|辛苦|乖|抱抱|关心/.test(t))
        return { emotion: '愉悦', intensity: '温和', intimacy: 2, affection: 2, activity: '被你一句话哄得开怀，眉眼都弯起来' }
      if (/抱|亲|温柔|哄|宠|贴贴|摸摸|牵/.test(t))
        return { emotion: '温柔', intensity: '情动', intimacy: 3, affection: 2, activity: '脸颊泛起暖意，语气比刚才软了几分' }
      if (/讨厌|混蛋|滚|别烦|走开|废话|闭嘴|不聊|分手/.test(t))
        return { emotion: '嘟囔', intensity: '低落', intimacy: -2, affection: -1, activity: '撇撇嘴，赌气地转过身去看吧台' }
      if (/沉默|没空|无聊|随便|嗯|哦/.test(t))
        return { emotion: '平静', intensity: '清淡', intimacy: 0, affection: -1, activity: '有一搭没一搭地擦着杯子，等你开口' }
      return null
    }

    // 当 AI 某轮忘了写标记时，从回复文字里轻量推断情绪漂移，保持连续性。
    function driftFromReply(text) {
      const t = String(text || '')
      if (/害羞|脸红|耳根|慌乱/.test(t)) return { emotion: '羞涩', intensity: '微微' }
      if (/温柔|放软|轻声|笑意/.test(t)) return { emotion: '温柔', intensity: '温和' }
      if (/叹气|沉默|低落|难过/.test(t)) return { emotion: '低沉', intensity: '低沉' }
      if (/笑|开心|开怀|弯起/.test(t)) return { emotion: '愉悦', intensity: '高涨' }
      if (/恼|皱眉|瞪|撇嘴/.test(t)) return { emotion: '烦躁', intensity: '偏激' }
      return null
    }

    // 已处理过的回复去重（防止订阅抖动导致记忆重复入库）。
    const seenTurns = new Set()
    let seenTurnsCount = 0
    // 已消费过"自动驱动"的节点（避免同一条消息每帧重复推断、数值反复叠加）。
    const autoSeen = new Set()
    let autoSeenCount = 0

    // ── M5：结构化工具状态（权威优先）─────────────────────────────────
    // manage_tavern_state 的 output.render 把合并后的完整状态写成
    // `[TAVERN-STATE]` + JSON 文本块，落入会话快照的工具结果节点。
    // 与模型自由文本无关，解析结果据此做覆盖式更新，天然免疫格式/繁简/别名问题。
    const TOOL_STATE_MARKER = '[TAVERN-STATE]'
    function parseToolStateMarker(text) {
      if (!text || typeof text !== 'string') return null
      const idx = text.indexOf(TOOL_STATE_MARKER)
      if (idx < 0) return null
      const sub = String(text).slice(idx + TOOL_STATE_MARKER.length).trim()
      if (sub.startsWith('{')) {
        try { return JSON.parse(sub) } catch { /* 可能带尾随文本，走花括号提取 */ }
        const e = sub.lastIndexOf('}')
        if (e > 0) { try { return JSON.parse(sub.slice(0, e + 1)) } catch { return null } }
        return null
      }
      const b = sub.indexOf('{')
      const e = sub.lastIndexOf('}')
      if (b < 0 || e < 0 || e <= b) return null
      try { return JSON.parse(sub.slice(b, e + 1)) } catch { return null }
    }

    // 内置文本字段（可被工具结果直接覆盖的键，供 scanForTavern 使用）。
    const TOOL_TEXT_KEYS = ['scene', 'time', 'emotion', 'intensity', 'activity']
    const TOOL_NUM_KEYS = ['intimacy', 'affection', 'trust']

    // 工具结果是权威绝对状态：按字段覆盖（数值夹 0~100，custom 按变量表类型规整后整体覆盖）。
    // defs 可选：外部可注入`{ key: type }`变量表（便于单测）；缺省时从配置里解析。
    function applyToolState(prev, payload, defs) {
      const s = { ...(prev || {}) }
      if (!payload || typeof payload !== 'object') return s
      for (const k of TOOL_TEXT_KEYS) {
        if (payload[k] != null) s[k] = payload[k]
      }
      const num = (v, fb) => {
        const n = Number(v)
        return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : fb
      }
      for (const k of TOOL_NUM_KEYS) {
        if (payload[k] != null) s[k] = num(payload[k], s[k])
      }
      if (payload.custom && typeof payload.custom === 'object') {
        if (!defs) {
          defs = {}
          try {
            const cfg = loadTavernConfig() || {}
            for (const v of (cfg.customStates || [])) if (v && v.key) defs[v.key] = v.type
          } catch { /* 忽略 */ }
        }
        const out = {}
        for (const [k, raw] of Object.entries(payload.custom)) {
          const t = defs[k]
          if (t === 'counter') { const n = Number(raw); out[k] = String(Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0) }
          else if (t === 'meter') { const n = Number(raw); out[k] = String(Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0) }
          else out[k] = raw
        }
        // 合并而非覆盖：保留已有 custom 字段的同时用新值覆盖，避免 payload 缺少部分字段时旧数据丢失。
        s.custom = { ...(prev.custom || {}), ...out }
      }
      return s
    }

    // ── 稳定数据层接口（M1 模块化边界）─────────────────────────────────
    // 目的：把依赖 localStorage / React 之外的数据逻辑聚合为单一稳定入口，
    // 便于独立测试与后续替换内部实现（如 M5 引入服务端为状态权威源）。
    // 注意：本文件各函数定义在下方，这里只是收口为命名空间，不改变任何调用链，
    // 也不破坏 __ModuleLoader__ 单文件加载闭环（不引入跨文件 require）。
    const TavernData = {
      // 状态存储（按 personaId 分区）
      loadState: (pid) => loadTavernState(pid),
      saveState: (pid, s) => saveTavernState(pid, s),
      // 配置存取（customStates 变量表）
      loadConfig: () => loadTavernConfig(),
      saveConfig: (cfg) => saveTavernConfig(cfg),
      // 状态标记解析
      parseState: (text) => extractStateUpdate(text),
      parseMemory: (text) => extractMemory(text),
      // 合并
      merge: (prev, upd) => mergeState(prev, upd),
      mergeAuto: (prev, d) => mergeAuto(prev, d),
    }

    // 从会话快照里扫描状态与记忆。返回 Promise<boolean>（状态是否更新）。
    // opts: { personaId, sessionId, onMemory } —— 命中【记忆】且持有 personaId 时，回调交给面板写入记忆系统。
    // 自动驱动：不再只取"最新的 AI 标记"，而是顺序消费每条新消息——
    //   1) 你每说一句话 → 即时推断老板娘的反应（sentimentDelta），状态立刻流动；
    //   2) AI 回复 → 优先用【状态更新】标记推进（权威），没写标记时用文字轻量推断（driftFromReply）兜底，保持连续。
    async function scanForTavern(session, apply, { personaId, sessionId, onMemory } = {}) {
      let snap
      try {
        snap = session && typeof session.getSnapshot === 'function' ? session.getSnapshot() : null
      } catch { return false }
      if (!snap) return false
      // 调试：打印快照结构
      const topKeys = Object.keys(snap || {})
      const snapSummary = {}
      for (const k of topKeys) {
        const v = snap[k]
        if (Array.isArray(v)) snapSummary[k] = `Array(${v.length})`
        else if (v && typeof v === 'object') snapSummary[k] = `Object(${Object.keys(v).join(',')})`
        else snapSummary[k] = String(v).slice(0, 50)
      }
      console.log('[tavern] snapshot keys:', topKeys, 'summary:', snapSummary)
      if (snap.legacy) {
        console.log('[tavern] legacy keys:', Object.keys(snap.legacy))
        if (Array.isArray(snap.legacy.nodes)) console.log('[tavern] legacy.nodes.length=', snap.legacy.nodes.length)
      }
      if (Array.isArray(snap.nodes)) console.log('[tavern] snap.nodes.length=', snap.nodes.length)
      if (Array.isArray(snap.messages)) console.log('[tavern] snap.messages.length=', snap.messages.length)
      // legacy.nodes 是最稳定的扁平节点列表；顺序遍历，每个节点只消费一次。
      let nodes = snap.legacy && snap.legacy.nodes ? snap.legacy.nodes : []
      // 回退：尝试从 snap.chat.nodes 或 snap.nodes 或 snap.messages 获取
      if (nodes.length === 0 && snap.chat && Array.isArray(snap.chat.nodes)) {
        console.log('[tavern] using snap.chat.nodes, count=', snap.chat.nodes.length)
        nodes = snap.chat.nodes
      }
      if (nodes.length === 0) {
        const altNodes = Array.isArray(snap.nodes) ? snap.nodes : (Array.isArray(snap.messages) ? snap.messages : [])
        if (altNodes.length > 0) {
          console.log('[tavern] legacy.nodes empty, trying altNodes, count=', altNodes.length)
          nodes = altNodes
        }
      }
      // 调试第一个节点结构
      if (nodes.length > 0) {
        const sample = nodes[0]
        const sampleKeys = Object.keys(sample)
        console.log('[tavern] first node keys:', sampleKeys, 'sample:', {
          kind: sample.kind,
          hasContent: Array.isArray(sample.content),
          contentLen: Array.isArray(sample.content) ? sample.content.length : 0,
          hasBlocks: Array.isArray(sample.blocks),
          blocksLen: Array.isArray(sample.blocks) ? sample.blocks.length : 0,
          blocksSample: Array.isArray(sample.blocks) ? sample.blocks.slice(0, 2).map(b => b ? ({ type: b.type, kind: b.kind, ...(b.text !== undefined ? { text: String(b.text).slice(0, 100) } : {}), ...(b.toolCall !== undefined ? { toolCall: true } : {}), keys: Object.keys(b) }) : null) : null,
        })
        // 也查看最后几个节点
        const lastNodes = nodes.slice(-3)
        for (const n of lastNodes) {
          if (n && n.kind && (Array.isArray(n.content) || Array.isArray(n.blocks))) {
            const blocks = Array.isArray(n.blocks) ? n.blocks : (Array.isArray(n.content) ? n.content : [])
            const textBlocks = blocks.filter(b => b && (b.type === 'text' || b.kind === 'text' || b.kind === 'assistant'))
            const toolBlocks = blocks.filter(b => b && (b.type === 'tool' || b.kind === 'tool'))
            console.log('[tavern] node kind=', n.kind, 'blocks total=', blocks.length, 'text blocks=', textBlocks.length, 'tool blocks=', toolBlocks.length,
              'text preview:', textBlocks.map(b => String(b.text || '').slice(0, 150)).join(' | '),
              'tool preview:', toolBlocks.map(b => ({ ...(b.toolName ? { name: b.toolName } : {}), ...(b.payload ? { payload: String(b.payload).slice(0, 100) } : {}) }))
            )
            // 输出原始 blocks 结构，帮助诊断
            blocks.forEach((b, bi) => {
              if (b) {
                const dump = { type: b.type, keys: Object.keys(b) }
                // 尝试输出所有可能的文本字段
                for (const k of ['text', 'content', 'value', 'body', 'message', 'msg']) {
                  if (b[k] !== undefined) dump[k] = String(b[k]).slice(0, 200)
                }
                console.log('[tavern]   block[' + bi + '] raw:', JSON.stringify(dump))
              }
            })
          }
        }
      }
      const effectiveNodes = nodes
      console.log('[tavern] scanForTavern called, nodes.length=', effectiveNodes.length, 'node.kinds=', effectiveNodes.map(n => n && n.kind).slice(-5))
      let changed = false
      // 本轮是否已出现过权威工具状态；出现后，同回合的文本【状态更新】降级为不采信。
      let toolStateInTurn = false
      for (let i = 0; i < effectiveNodes.length; i++) {
        const n = effectiveNodes[i]
        if (!n || !(Array.isArray(n.content) || Array.isArray(n.blocks))) continue
        const blocks = Array.isArray(n.blocks) ? n.blocks : (Array.isArray(n.content) ? n.content : [])
        const text = blocks.map(b => (b && (b.type === 'text' || b.kind === 'text' || b.kind === 'assistant') && b.text) ? b.text : '').join('\n')
        if (!text) continue
        if (text.indexOf(TOOL_STATE_MARKER) >= 0) {
          console.log('[tavern] FOUND tool-state marker in node', i, 'kind=', n.kind, 'text preview=', text.slice(0, 200))
        }
        const pid = personaId || null
        const mark = (kind) => `${sessionId || ''}:${kind}:${i}`
        const consume = (kind) => {
          const k = mark(kind)
          if (autoSeen.has(k)) return false
          autoSeen.add(k)
          if (++autoSeenCount > 1000) { autoSeen.clear(); autoSeenCount = 0 }
          return true
        }

        // M5：结构化工具状态（权威，绝对覆盖）。命中即应用并以工具结果为该回合状态真相。
        if (text.indexOf(TOOL_STATE_MARKER) >= 0) {
          const payload = parseToolStateMarker(text)
          console.log('[tavern] scanForTavern tool-state marker found, payload=', payload, 'consume=', consume('tool'))
          if (payload && consume('tool')) {
            const prev = loadTavernState(pid)
            const merged = applyToolState(prev, payload)
            console.log('[tavern] applyToolState prev.custom=', prev.custom, 'merged.custom=', merged.custom)
            saveTavernState(pid, merged)
            apply(merged)
            changed = true
            toolStateInTurn = true
          }
          continue
        }

        // 1) 用户消息 → 自动驱动即时反应。（新回合，清除工具权威标记）
        if (n.kind === 'user') {
          toolStateInTurn = false
          if (consume('user')) {
            const d = sentimentDelta(text)
            if (d) {
              const merged = mergeAuto(loadTavernState(pid), d)
              saveTavernState(pid, merged)
              apply(merged)
              changed = true
            }
          }
          continue
        }

        // 2) 助手回复 → 优先用结构化工具状态（已应用过则同回合文本不再覆写）；
        //    无工具时回退：标记优先，缺标记则由文字轻量推断兜底。
        if (n.kind === 'assistant') {
          if (consume('asst')) {
            if (toolStateInTurn) {
              // 本回合工具已是权威，跳过文本状态兜底，但记忆联动仍保留。
              if (onMemory && personaId && !seenTurns.has(text)) {
                seenTurns.add(text)
                if (++seenTurnsCount > 300) { seenTurns.clear(); seenTurnsCount = 0 }
                const mem = extractMemory(text)
                if (mem) onMemory(mem)
              }
              continue
            }
            const upd = extractStateUpdate(text)
            if (upd) {
              const merged = mergeState(loadTavernState(pid), upd)
              saveTavernState(pid, merged)
              apply(merged)
              changed = true
            } else {
              const d = driftFromReply(text)
              if (d) {
                const merged = mergeAuto(loadTavernState(pid), d)
                saveTavernState(pid, merged)
                apply(merged)
                changed = true
              }
            }
            // 记忆联动：未处理过的回复若有【记忆】，回调写入 persona 记忆系统。
            if (onMemory && personaId && !seenTurns.has(text)) {
              seenTurns.add(text)
              if (++seenTurnsCount > 300) { seenTurns.clear(); seenTurnsCount = 0 }
              const mem = extractMemory(text)
              if (mem) onMemory(mem)
            }
          }
        }
      }
      return changed
    }

    // ── Tavern Panel (conversation.input.dock) ────────────────────────────

    function TavernPanel(props) {
      const [active, setActive] = useState(null)
      const [memories, setMemories] = useState([])
      const [loading, setLoading] = useState(true)
      const [status, setStatus] = useState(() => loadTavernState(null))
      const [portraits, setPortraits] = useState([]) // 已缓存立绘文件名列表
      // 窗口宽度跟踪：让状态栏随网页缩放自适应（宽屏两栏 / 中屏缩列 / 窄屏上下堆叠）。
      const [winW, setWinW] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1200))
      useEffect(() => {
        const onR = () => setWinW(window.innerWidth)
        window.addEventListener('resize', onR)
        return () => window.removeEventListener('resize', onR)
      }, [])

      // 状态栏可折叠：点右下角「收起」变为精简条（只留立绘/情绪/三数值），把空间退给聊天记录。
      // 折叠偏好持久化到 localStorage：用户收起过一次后，下次进入酒馆默认保持折叠状态。
      const [collapsed, setCollapsed] = useState(() => {
        try { return localStorage.getItem(TAVERN_COLLAPSE_KEY) === '1' } catch { return false }
      })
      useEffect(() => {
        try { localStorage.setItem(TAVERN_COLLAPSE_KEY, collapsed ? '1' : '0') } catch { /* 存储失败忽略 */ }
      }, [collapsed])
      // M7：回合变化提示——本轮有数值/情绪/场景变动时，在卡片右上角短暂点名反馈（绝对定位，不挤聊天区）。
      const [turnNote, setTurnNote] = useState(null)
      const turnCounter = useRef(0)
      const turnClear = useRef(null)
      const prevStatusRef = useRef(null)
      const ctx = props.ctx
      const sessionId = props.session?.sessionId

      // 自门控：仅 tavern（酒馆模式）会话渲染本卡片；普通会话返回空，
      // 不占用布局、不请求角色数据，也不影响其它系统入口的显示。
      const [agentPreset, setAgentPreset] = useState(() =>
        sessionId ? ctx?.sessions?.list?.getSnapshot()?.byId?.[sessionId]?.agentPreset : undefined)
      useEffect(() => {
        if (!ctx?.sessions?.list || !sessionId) return
        return ctx.sessions.list.subscribe(() => {
          setAgentPreset(ctx.sessions.list.getSnapshot().byId?.[sessionId]?.agentPreset)
        })
      }, [ctx, sessionId])
      const isTavern = agentPreset === 'tavern'

      // 标记隐藏器跟随酒馆会话：是酒馆则启用拦截，否则关闭（防止普通会话被误伤）。
      useEffect(() => {
        ensureMarkerHider()
        tavernMarker.enabled = isTavern
        if (isTavern && tavernMarker.hide) tavernMarker.hide()
        return () => { tavernMarker.enabled = false }
      }, [isTavern])

      // 反向同步：酒馆模式启动时，把 config.json（config-server 提供）里预置的
      // 自定义变量合入 localStorage。否则后台文件直接改的变量，前端状态栏读不到。
      const [serverCfgGen, setServerCfgGen] = useState(0)
      useEffect(() => {
        if (!isTavern) return
        let cancelled = false
        fetch(`${cfgBase()}/api/tavern/config`)
          .then(r => (r.ok ? r.json() : Promise.reject()))
          .then(remote => {
            if (cancelled || !remote || !Array.isArray(remote.customStates)) return
            const cur = loadTavernConfig() || {}
            const map = new Map()
            for (const v of (cur.customStates || [])) if (v && v.key) map.set(v.key, v)
            for (const v of remote.customStates) if (v && v.key && !map.has(v.key)) map.set(v.key, v)
            const merged = Array.from(map.values())
            if (merged.length !== (cur.customStates || []).length) {
              saveTavernConfig({ ...cur, customStates: merged })
            }
          })
          .catch(() => {})
          .then(() => { if (!cancelled) setServerCfgGen(g => g + 1) })
        return () => { cancelled = true }
      }, [isTavern])

      // 响应式断点：由窗口宽度派生，驱动状态栏布局与立绘尺寸自适应。
      const narrow = winW < 680          // 窄屏：上下堆叠、立绘不破顶
      const compact = winW >= 680 && winW < 920   // 中屏：立绘缩小、右栏收紧
      const pPad = narrow ? 14 : compact ? 18 : 24

      // 营业时长（分钟）：进入酒馆会话即开始累计，营造"酒馆在营业、时间在流动"的感知。
      const [openMin, setOpenMin] = useState(0)
      useEffect(() => {
        if (!isTavern) return
        setOpenMin(0)
        const t = setInterval(() => setOpenMin(m => m + 1), 60000)
        return () => clearInterval(t)
      }, [isTavern])

      // 当前当班老板的 personaId（供记忆联动写入使用；用 ref 避免反复重建订阅）。
      const activeIdRef = useRef(null)
      // 全局活跃 personaId（不依赖酒馆模式，供全局记忆扫描器使用）。
      const globalActiveIdRef = useRef(null)

      // M7：比较上一轮状态，把本轮变动的字段整理成一句点名反馈，短暂浮现在卡片右上角。
      // 只做展示不占布局（绝对定位），数值/情绪/场景任意变化都会触发；不变则无提示。
      useEffect(() => {
        if (!prevStatusRef.current) { prevStatusRef.current = status; return }
        const prev = prevStatusRef.current
        prevStatusRef.current = status
        const parts = []
        // 内置数值：只报变动（点名"亲密度 55"）——中文标签内联映射。
        const numLabel = { intimacy: '亲密', affection: '好感', trust: '信任' }
        for (const k of ['intimacy', 'affection', 'trust']) {
          if (Number(status[k]) !== Number(prev[k])) parts.push(`${numLabel[k]} ${status[k]}`)
        }
        // 情绪 / 场景 / 时间：文本级，点名一次
        if (status.emotion && status.emotion !== prev.emotion) parts.push(`${status.emotion}`)
        if (status.scene && status.scene !== prev.scene) parts.push(`@${status.scene}`)
        if (status.time && status.time !== prev.time) parts.push(`时·${status.time}`)
        if (!parts.length) return
        turnCounter.current += 1
        const token = turnCounter.current
        const text = parts.slice(0, 4).join(' · ')
        setTurnNote({ text, token })
        if (turnClear.current) clearTimeout(turnClear.current)
        turnClear.current = setTimeout(() => setTurnNote(n => (n && n.token === token ? null : n)), 4600)
      }, [status])

      // 记忆联动：把聊天里沉淀出的【记忆】写进 persona 记忆库，并即时反映到卡片。
      const handleMemory = useCallback(async (content) => {
        const pid = activeIdRef.current
        if (!pid) return
        try {
          const r = await memApi(pid, '/add', 'POST', { content, tags: ['酒馆', '回忆'] })
          if (r.ok && r.memory) {
            setMemories(prev => {
              const arr = prev.filter(m => m.id !== r.memory.id)
              return [r.memory, ...arr].slice(0, 40)
            })
          }
        } catch { /* 记忆写入失败不阻断对话 */ }
      }, [])

      // ── 全局活跃人设获取（不依赖酒馆模式）──────────────────────────────────
      // 无论当前处于酒馆还是标准模式，只要有活跃角色，就要能查出其 ID，
      // 供全局记忆扫描器使用。
      useEffect(() => {
        let cancelled = false
        ;(async () => {
          try {
            const r = await api('/active')
            if (!cancelled && r.ok && r.persona) {
              globalActiveIdRef.current = r.persona.id
            }
          } catch {}
        })()
        return () => { cancelled = true }
      }, [sessionId])

      // ── 全局记忆扫描器（所有会话都运行，不依赖酒馆模式）────────────────────
      // 记忆系统是全局共享的，酒馆只是消费端之一。AI 在任何会话的回复中写入
      // 【记忆】标记，都应被捕获并持久化到角色的记忆库。酒馆模式下，酒馆自身
      // 的扫描器已通过 onMemory 回调写入，此处跳过以避免重复写入。
      useEffect(() => {
        if (!sessionId || !ctx?.sessions) return

        const seenTexts = new Set()

        const scan = () => {
          const session = ctx.sessions.binding(sessionId)?.session
          if (!session) return

          let snap
          try { snap = session.getSnapshot() } catch { return }
          if (!snap) return

          let nodes = snap.legacy?.nodes || []
          if (!nodes.length && snap.chat?.nodes) nodes = snap.chat.nodes
          if (!nodes.length) nodes = snap.nodes || snap.messages || []
          if (!nodes.length) return

          const pid = globalActiveIdRef.current
          if (!pid) return

          for (const n of nodes) {
            const blocks = Array.isArray(n.blocks) ? n.blocks : (Array.isArray(n.content) ? n.content : [])
            if (!blocks.length) continue
            const text = blocks.map(b => (b && b.text) ? b.text : '').join('\n')
            if (!text || seenTexts.has(text)) continue
            seenTexts.add(text)

            const mem = extractMemory(text)
            if (!mem) continue

            console.log('[tavern] global memory scanner: extracted memory content=', mem.slice(0, 120))

            // 酒馆模式下，tavern 自身的扫描器已通过 onMemory 回调写入，跳过以免重复。
            if (isTavern) { console.log('[tavern] global memory scanner: skipped (tavern mode)'); continue }

            // 非酒馆模式：直接写入记忆 API
            console.log('[tavern] global memory scanner: writing to memApi, pid=', pid)
            memApi(pid, '/add', 'POST', { content: mem, tags: ['回忆'] }).catch(() => {})
          }
        }

        const sessionObj = ctx.sessions.binding(sessionId)?.session
        const un1 = sessionObj ? sessionObj.subscribe(scan) : undefined
        const un2 = ctx.sessions.list?.subscribe ? ctx.sessions.list.subscribe(scan) : undefined
        return () => { if (un1) un1(); if (un2) un2() }
      }, [sessionId, ctx, isTavern])

      // 订阅该酒馆会话的最新回复，解析【状态更新】刷新面板、【记忆】写入记忆系统。
      // 双路订阅：会话就绪后由它持续驱动；就绪前由 list 驱动，确保 session 一旦出现就补扫，
      // 避免 effect 建立时机早于会话 ready 导致永久不更新。scan 本身幂等，重复触发安全。
      // 增加 scanningRef 防重入：scanForTavern 内 setStatus 触发 re-render 后，旧订阅清理 + 新订阅创建
      // 会导致同一轮状态变更再触发一次 scan，形成无限循环。用 flag 在 200ms 内拦截重复调用。
      const scanningRef = useRef(false)
      useEffect(() => {
        if (!isTavern || !sessionId || !ctx?.sessions) return
        const apply = (s) => { console.log('[tavern] apply() called with state.custom=', s.custom, 'intimacy=', s.intimacy); setStatus(s) }
        const scan = () => {
          if (scanningRef.current) return
          scanningRef.current = true
          setTimeout(() => { scanningRef.current = false }, 200)
          const session = ctx.sessions.binding(sessionId)?.session
          if (!session) { scanningRef.current = false; return }
          console.log('[tavern] scan triggered for session', sessionId)
          scanForTavern(session, apply, {
            personaId: activeIdRef.current,
            sessionId,
            onMemory: handleMemory,
          })
        }
        const bound = ctx.sessions.binding(sessionId)?.session
        const un1 = bound ? bound.subscribe(scan) : undefined
        const un2 = ctx.sessions.list?.subscribe ? ctx.sessions.list.subscribe(scan) : undefined
        return () => { if (un1) un1(); if (un2) un2() }
      }, [isTavern, sessionId, ctx, handleMemory])

      useEffect(() => {
        if (!isTavern) { setLoading(false); return }
        let timer = null
        ;(async () => {
          const activeR = await api('/active')
          const a = activeR.ok && activeR.persona ? activeR.persona : null
          setActive(a)
          activeIdRef.current = a ? a.id : null
          if (a) {
            setStatus(loadTavernState(a.id))
            const r = await memApi(a.id, '/list', 'GET')
            if (r.ok) setMemories(r.memories || [])
            const pr = await api(`/${a.id}/portraits`)
            if (pr.ok) setPortraits(pr.portraits || [])
          }
          setLoading(false)
        })()
        // 轮询立绘清单：手动生成后，状态栏能自动出现新立绘，无需重进酒馆。
        timer = setInterval(async () => {
          const pid = activeIdRef.current
          if (!pid) return
          const pr = await api(`/${pid}/portraits`)
          if (pr.ok) setPortraits(prev =>
            JSON.stringify(prev) === JSON.stringify(pr.portraits || []) ? prev : (pr.portraits || []))
        }, 4000)
        return () => { if (timer) clearInterval(timer) }
      }, [isTavern])

      if (!isTavern) return null
      if (loading) return React.createElement('div', { style: { padding: '16px', color: '#888', fontSize: '13px' } }, '加载中...')

      const theme = emotionTheme(status.emotion, status.intensity)
      const stage = stageOf(status.intimacy)
      const card = {
        background: theme.bg, borderRadius: '14px', padding: `${pPad}px`, color: '#f5efe8',
        fontFamily: 'system-ui, sans-serif', boxShadow: `0 10px 28px rgba(0,0,0,0.22), inset 0 0 60px ${theme.glow}14`,
        border: `1px solid ${theme.glow}40`, transition: 'background .5s, box-shadow .5s, border-color .5s',
        position: 'relative', overflow: 'visible', display: 'flex', flexDirection: 'column',
      }
      const cap = {
        fontSize: '12px', letterSpacing: '0.1em', textTransform: 'uppercase',
        color: '#d8b98a', fontWeight: 700, marginBottom: '6px',
      }
      const body = { fontSize: '15px', lineHeight: 1.6, color: '#e8ddd2' }
      const statusItem = { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }
      const statusKey = { fontSize: '11px', color: '#b09a82', fontWeight: 600 }
      const statusVal = { fontSize: '14px', fontWeight: 700, color: '#f5efe8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
      const barWrap = { height: '5px', borderRadius: '3px', background: 'rgba(255,255,255,0.12)', overflow: 'hidden', marginTop: '2px' }
      const barFill = { height: '100%', background: 'linear-gradient(90deg,#b8865b,#e0a96e)', borderRadius: '3px', transition: 'width .4s' }

      const statBar = (label, value, color, changed) =>
        React.createElement('div', { style: { ...statusItem, flex: '1 1 130px' } },
          React.createElement('span', { key: changed ? `${label}:${value}` : label, style: { ...statusKey, ...(changed ? { animation: 'tavernRefreshGlow 1.1s ease-out', color: '#ffd98a' } : {}) } }, `${label} ${value}/100`),
          React.createElement('div', { style: barWrap },
            React.createElement('div', { style: { ...barFill, width: `${value}%`, background: color } }),
          ),
        )

      // M7：本轮已变化的字段集合（基于上一渲染状态），用于给数值/自定义项补"变化高亮"。
      const changedNum = new Set()
      const changedCustom = new Set()
      if (prevStatusRef.current) {
        const prevSt = prevStatusRef.current
        for (const k of ['intimacy', 'affection', 'trust']) {
          if (Number(status[k]) !== Number(prevSt[k])) changedNum.add(k)
        }
        const prevCustom = prevSt.custom || {}
        for (const [k, v] of Object.entries(status.custom || {})) {
          if (String(prevCustom[k]) !== String(v)) changedCustom.add(k)
        }
      }

      const stageChip = React.createElement('span', {
        style: { fontSize: '12px', background: `${stage.color}22`, color: stage.color, borderRadius: '999px', padding: '3px 10px', fontWeight: 700, marginLeft: '8px', flexShrink: 0 },
      }, stage.label)

      const face = emotionFace(status.emotion)
      const period = nowPeriod()

      const pk = portraitKey(status.emotion)
      const portraitUrl = (active && portraits.includes(`${pk}.png`))
        ? `${apiBase()}/${active.id}/portrait/${pk}.png`
        : null

      // 折叠版：仅保留立绘缩略 + 情绪 + 三数值，右下角可展开，占地不挤聊天记录。
      if (collapsed) {
        const ck = portraitKey(status.emotion)
        const cUrl = (active && portraits.includes(`${ck}.png`)) ? `${apiBase()}/${active.id}/portrait/${ck}.png` : null
        return React.createElement('div', { style: { ...card, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: '12px' } },
          cUrl
            ? React.createElement('img', { src: cUrl, alt: active ? active.name : '老板娘', style: { width: '52px', height: '52px', objectFit: 'cover', borderRadius: '8px', border: `2px solid ${theme.glow}66`, flexShrink: 0, pointerEvents: 'none' } })
            : React.createElement('div', { style: { fontSize: '32px', width: '52px', height: '52px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 } }, face.emoji),
          React.createElement('div', { style: { flex: 1, minWidth: 0 } },
            React.createElement('div', { style: { fontSize: '14px', fontWeight: 700, color: '#f5efe8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, `${active ? active.name : '老板娘'} · ${status.emotion}${status.intensity ? `（${status.intensity}）` : ''}`),
            React.createElement('div', { style: { fontSize: '12px', color: '#d8b98a', marginTop: '2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, `亲密 ${status.intimacy} · 好感 ${status.affection} · 信任 ${status.trust}`),
          ),
          React.createElement('button', { onClick: () => setCollapsed(false), title: '展开状态栏', style: { border: 0, cursor: 'pointer', background: `${theme.glow}22`, color: '#f5efe8', borderRadius: '8px', padding: '5px 12px', fontSize: '12px', fontWeight: 700, fontFamily: 'inherit', flexShrink: 0 } }, '▴ 展开'),
        )
      }

      const portraitSize = 140
      const portraitPop = 28  // 破窗上探量
      // 立绘：正方形展示，完整显示角色面部，增强互动性和情绪表达
      const enhancedPortrait = portraitUrl
        ? React.createElement('div', {
            style: {
              position: 'relative', flexShrink: 0, width: `${portraitSize}px`, height: `${portraitSize}px`,
              alignSelf: 'center', zIndex: 5,
              marginTop: `-${portraitPop}px`,  // 破窗：上探出卡片顶边
              marginBottom: `-${portraitPop}px`, // 补偿：原属上探空间的垂直空间还给版心
              borderRadius: '12px', overflow: 'hidden',
              border: `3px solid ${theme.glow}88`,
              boxShadow: `0 8px 24px rgba(0,0,0,0.55), 0 0 20px ${theme.glow}45, inset 0 0 30px ${theme.glow}08`,
              transition: 'transform 0.3s ease-out, box-shadow 0.3s ease-out, border-color 0.5s',
              cursor: 'pointer',
            },
            onMouseEnter: (e) => { e.currentTarget.style.transform = 'scale(1.04)'; e.currentTarget.style.boxShadow = `0 12px 32px rgba(0,0,0,0.65), 0 0 28px ${theme.glow}55`; },
            onMouseLeave: (e) => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.boxShadow = `0 8px 24px rgba(0,0,0,0.55), 0 0 20px ${theme.glow}45, inset 0 0 30px ${theme.glow}08`; },
          },
            React.createElement('img', {
              src: portraitUrl,
              alt: active ? active.name : '老板娘',
              style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block', pointerEvents: 'none', animation: 'tavernBreath 4.5s ease-in-out infinite' },
            }),
            // 情绪角标：左下角突出显示当前情绪，增加互动反馈
            React.createElement('div', { style: { position: 'absolute', left: '-6px', bottom: '8px', padding: '4px 14px 4px 18px', background: theme.glow, color: '#1a1206', fontSize: '12px', fontWeight: 800, borderRadius: '999px', boxShadow: '0 4px 14px rgba(0,0,0,0.45)' } }, status.emotion),
          )
        : React.createElement('div', {
            style: {
              width: `${portraitSize}px`, height: `${portraitSize}px`,
              flexShrink: 0, alignSelf: 'flex-start',
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              justifyContent: 'center', gap: '8px',
              background: `linear-gradient(160deg, ${theme.glow}1e, rgba(0,0,0,0.25))`,
              border: `2px dashed ${theme.glow}50`, borderRadius: '12px',
              boxShadow: `inset 0 0 20px ${theme.glow}08`,
            },
          },
            React.createElement('div', { style: { fontSize: '48px', lineHeight: 1, filter: 'drop-shadow(0 4px 12px rgba(0,0,0,0.4))' } }, face.emoji),
            React.createElement('div', { style: { fontSize: '11px', fontWeight: 700, letterSpacing: '0.05em', color: theme.glow } }, '立绘待生成'),
          )

      return React.createElement('div', { style: { ...card, padding: '16px 18px' } },
        // 横向布局：立绘 + 状态信息 + 折叠按钮
        React.createElement('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '18px' } },
          // 立绘（正方形，完整展示角色面部，增强情绪表达）
          enhancedPortrait,
          // 状态信息
          React.createElement('div', { style: { flex: 1, minWidth: 0 } },
            // 第一行：名称 + 情绪 + 场景 + 时段
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '6px' } },
              React.createElement('span', { style: { fontSize: '14px', fontWeight: 700, color: '#f5efe8' } }, `${active ? active.name : '老板娘'} · ${status.emotion}${status.intensity ? `（${status.intensity}）` : ''}`),
              React.createElement('span', { style: { fontSize: '12px', color: '#b09a82' } }, `${status.scene} · ${status.time}`),
              stageChip,
            ),
            // 第二行：三数值进度条
            React.createElement('div', { style: { display: 'flex', gap: '14px', marginBottom: '6px', flexWrap: 'wrap' } },
              statBar('亲密', status.intimacy, 'linear-gradient(90deg,#b8865b,#e0a96e)', changedNum.has('intimacy')),
              statBar('好感', status.affection, 'linear-gradient(90deg,#e08ab8,#f0a6c8)', changedNum.has('affection')),
              statBar('信任', status.trust, 'linear-gradient(90deg,#7c9bd6,#9fc3ec)', changedNum.has('trust')),
            ),
            // 自定义状态标签
            ...(() => {
              const parsed = status.custom || {}
              const keys = Object.keys(parsed)
              if (!keys.length) return []
              return [React.createElement('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
                keys.slice(0, 5).map(k =>
                  React.createElement('span', { key: k, style: { fontSize: '11px', background: `${theme.glow}22`, color: theme.glow, borderRadius: '5px', padding: '2px 8px', fontWeight: 600, ...(changedCustom.has(k) ? { animation: 'tavernRefreshGlow 1.1s ease-out', color: '#ffd98a' } : {}) } }, `${k} ${parsed[k]}`)
                )
              )]
            })(),
          ),
        ),
        // 折叠按钮（移至卡片底部，与记忆区块并列）
        React.createElement('button', { onClick: () => setCollapsed(true), title: '收起状态栏', style: { border: 0, cursor: 'pointer', background: `${theme.glow}22`, color: '#f5efe8', borderRadius: '8px', padding: '4px 10px', fontSize: '12px', fontWeight: 700, fontFamily: 'inherit', flexShrink: 0, alignSelf: 'flex-end', marginTop: '8px' } }, '▾ 收起'),
        // 记忆区域（滚动）
        React.createElement('div', { style: { marginTop: '12px' } },
          React.createElement('span', { style: { fontSize: '11px', color: '#d8b98a', fontWeight: 700, letterSpacing: '0.05em', marginBottom: '4px', display: 'block' } }, '记忆'),
          memories.length === 0
            ? React.createElement('div', { style: { fontSize: '12px', color: '#8a7a6a' } }, '还没有记忆，聊过之后会慢慢存下。')
            : React.createElement('div', { style: { maxHeight: '140px', overflowY: 'auto', paddingRight: '4px' } },
                memories.slice(0, 15).map((m, idx) =>
                  React.createElement('div', { key: m.id, style: { fontSize: '13px', lineHeight: 1.6, color: '#d8c8b8', padding: '4px 0', borderBottom: idx < Math.min(memories.length, 15) - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none' } },
                    m.content,
                    React.createElement('span', { style: { fontSize: '10px', color: '#8a7a6a', marginLeft: '6px' } },
                      (m.tags || []).slice(0, 2).join(' · ')
                    )
                  )
                )
              )
        ),
        // M7：回合变化提示
        turnNote
          ? React.createElement('div', { key: turnNote.token, style: { position: 'absolute', top: '8px', right: '8px', zIndex: 6, pointerEvents: 'none', fontSize: '11px', fontWeight: 700, color: '#ffd98a', background: '#3a2410cc', border: '1px solid #ffd98a55', borderRadius: '999px', padding: '2px 8px', animation: 'tavernTurnIn 4.6s ease-out forwards', maxWidth: '50%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, `本轮变化 · ${turnNote.text}`)
          : null,
      )
    }

    // ── Tavern Settings (酒馆设置) panel ──────────────────────────────────

    const TAVERN_CONFIG_KEY = 'dsh.tavern.config.v1'
    const loadTavernConfig = () => {
      try {
        const raw = localStorage.getItem(TAVERN_CONFIG_KEY)
        return raw ? JSON.parse(raw) : null
      } catch { return null }
    }
    const saveTavernConfig = (cfg) => {
      try { localStorage.setItem(TAVERN_CONFIG_KEY, JSON.stringify(cfg)); return true }
      catch { return false }
    }

    // 立绘情绪清单（与 persona 系统 PORTRAIT_EMOTIONS.key 一致，用于手动生成）。
    const EMOTION_LABELS = [
      ['neutral', '平静'],
      ['joy', '愉悦'],
      ['warm', '温柔'],
      ['tease', '挑逗'],
      ['angry', '烦躁'],
      ['sad', '难过'],
      ['shy', '羞涩'],
    ]

    // 立绘生成按钮（模块级 helper，避免深嵌套对象字面）。
    function portraitBtn(label, opts) {
      const has = opts.has, running = opts.running
      return React.createElement('button', {
        type: 'button',
        onClick: opts.onClick,
        disabled: opts.disabled || has,
        title: has ? `${label}立绘已生成` : (running ? '生成中…' : `生成「${label}」立绘`),
        style: {
          padding: '6px 10px', borderRadius: '6px',
          border: has ? '1px solid #16a34a' : '1px solid rgba(124,92,252,0.4)',
          background: has ? 'rgba(22,163,74,0.12)' : '#fff',
          color: has ? '#16a34a' : '#7c5cfc',
          fontSize: '12px', fontWeight: 600,
          cursor: opts.disabled || has ? 'default' : 'pointer',
          display: 'flex', alignItems: 'center', gap: '4px',
        },
      }, label, has ? ' ✓' : '')
    }

    // ── Tavern Diagnostics（诊断信息）────────────────────────────────────
    // 一键展示当前探测到的地址、配置来源、状态权威源与连接状态，供报障排查，
    // 全部信息只读、由前端实时探测，不触发任何写操作，不依赖后端新增端点。
    function TavernDiagnostics() {
      const [info, setInfo] = useState(null)
      const [busy, setBusy] = useState(false)
      const [checked, setChecked] = useState(false)

      const collect = useCallback(async () => {
        setBusy(true)
        const row = (label, val, ok) => ({ label, val, ok })
        const rows = []
        // 1. 地址探测链结果
        rows.push(row('API 基址', apiBase(), true))
        rows.push(row('记忆 API 基址', memApiBase(), true))
        rows.push(row('Config 基址', cfgBase(), true))
        // 2. 配置来源
        const localCfg = loadTavernConfig() || {}
        const varCount = (localCfg.customStates || []).length
        rows.push(row('本地变量表(localStorage)', `${varCount} 个变量`, true))
        // 3. 本地状态
        let stateInfo = '未记录'
        let stateVer = '-'
        try {
          const raw = localStorage.getItem(TAVERN_STATE_KEY)
          if (raw) {
            const st = JSON.parse(raw)
            stateInfo = `版本 v${st.version ?? '(旧)'} · 亲密 ${st.intimacy ?? '-'} / 好感 ${st.affection ?? '-'} / 信任 ${st.trust ?? '-'} · 自定义 ${Object.keys(st.custom || {}).length} 项`
            stateVer = String(st.version ?? '(旧)')
          }
        } catch { stateInfo = '解析失败' }
        rows.push(row('本地状态(localStorage)', stateInfo, true))
        // 4. config 服务可达性（live GET）
        let connOk = false, connDetail = '未检测'
        try {
          const res = await fetch(`${cfgBase()}/api/tavern/config`, { signal: AbortSignal.timeout(4000) })
          if (res.ok) { const j = await res.json(); connOk = true; connDetail = `HTTP ${res.status} · 服务端变量表 ${(j.customStates || []).length} 个` }
          else connDetail = `HTTP ${res.status}`
        } catch (e) { connDetail = `连接失败: ${e?.message || e}` }
        rows.push(row('config 服务(3081)', connDetail, connOk))
        // 5. 探测层来源
        rows.push(row('端口探测', describeProbe(), true))

        setInfo(rows)
        setChecked(true)
        setBusy(false)
      }, [])

      useEffect(() => { collect() }, [collect])

      const chipStyle = (ok) => ({ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', marginRight: '6px', background: ok ? '#16a34a' : '#eab308' })
      return React.createElement('div', {
        style: {
          padding: '14px 16px', borderRadius: '10px', marginTop: '18px',
          background: '#fbf7f1', border: '1px solid rgba(216,185,138,0.35)',
        }
      },
        React.createElement('div', { style: { fontSize: '14px', fontWeight: 700, color: '#3d3025', marginBottom: '2px' } }, '诊断信息'),
        React.createElement('div', { style: { fontSize: '11px', color: '#888', lineHeight: 1.5, marginBottom: '10px' } },
          '报障排查用：展示当前探测到的地址、配置来源与连接状态。信息只读，不修改任何数据。'
        ),
        !info
          ? React.createElement('div', { style: { fontSize: '12px', color: '#999' } }, '探测中…')
          : React.createElement('div', { style: { fontSize: '12px', lineHeight: 1.8, color: '#555' } },
              info.map((r, i) =>
                React.createElement('div', { key: i, style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                  React.createElement('span', { style: chipStyle(r.ok) }),
                  React.createElement('span', { style: { color: '#7a6a58', flexShrink: 0, width: '150px', fontWeight: 600 } }, r.label),
                  React.createElement('span', { style: { wordBreak: 'break-all', color: '#3d3025' } }, r.val),
                )
              )
            ),
        React.createElement('button', {
          type: 'button',
          onClick: collect,
          disabled: busy,
          style: {
            marginTop: '10px', padding: '5px 14px', borderRadius: '6px',
            border: '1px solid rgba(124,92,252,0.4)', background: '#fff',
            color: '#7c5cfc', fontSize: '12px', fontWeight: 600, cursor: busy ? 'default' : 'pointer',
          }
        }, busy ? '重新探测中…' : '重新探测'),
      )
    }

    function TavernSettingsEditor() {
      const [config, setConfig] = useState(() => loadTavernConfig() || {
        tavernName: '深夜小酒馆',
        worldBook: '',
        atmosphere: '',
        autoMemory: true,
        memoryDecay: 'normal',
        greeting: '',
        rules: [],
        customStates: DEFAULT_CUSTOM_STATES,
        // 端口覆盖（M2）：{ api: 18766, config: 3081 }，默认空则走探测链
        apiPorts: {},
      })
      const [saving, setSaving] = useState(false)
      const [activePersona, setActivePersona] = useState(null)
      const [savedFlash, setSavedFlash] = useState(false)

      // ── 立绘（手动触发生成，框架先行）────────────────────────────────
      const [portraits, setPortraits] = useState([])
      const [generating, setGenerating] = useState(null) // 'all' 或某 key，null 表示空闲
      const [drawingNote, setDrawingNote] = useState('')
      const [uploadMsg, setUploadMsg] = useState('')
      const uploadInputRef = useRef(null)
      const pendingKeyRef = useRef(null)

      useEffect(() => {
        ;(async () => {
          const r = await api('/active')
          if (r.ok && r.persona) {
            setActivePersona(r.persona)
            const pr = await api(`/${r.persona.id}/portraits`)
            if (pr.ok) setPortraits(pr.portraits || [])
          }
        })()
      }, [])

      // 手动生成
      const genPortraits = useCallback(async (key) => {
        if (!activePersona) return
        const isAll = !key
        const targets = isAll ? EMOTION_LABELS.map(e => e[0]) : [key]
        setGenerating(isAll ? 'all' : key)
        setDrawingNote(isAll
          ? '正在批量绘制 7 张表情…（免费档每张约数分钟，完成后自动出现）'
          : `正在绘制「${EMOTION_LABELS.find(e => e[0] === key)?.[1] || key}」表情…`)
        try {
          await api(`/${activePersona.id}/portraits/generate`, 'POST', {
            emotions: key ? [key] : null,
          })
        } catch { /* 受理失败不阻断；轮询会暴露无结果 */ }
        const pid = activePersona.id
        let ticks = 0
        const t = setInterval(async () => {
          let files = []
          const pr = await api(`/${pid}/portraits`)
          if (pr.ok) files = pr.portraits || []
          const latest = JSON.stringify(files)
          setPortraits(prev => JSON.stringify(prev) === latest ? prev : files)
          const missing = targets.filter(k => !files.includes(`${k}.png`))
          if (missing.length === 0) {
            clearInterval(t); setGenerating(null); setDrawingNote(`已完成，共 ${targets.length} 张立绘`)
            return
          }
          if (++ticks >= 600) { clearInterval(t); setGenerating(null); setDrawingNote('长时间未生成，请检查 NVIDIA_API_KEY 与额度') }
        }, 5000)
      }, [activePersona])

      // 自定义上传：选本地图 → 读成 dataURL → POST 到 persona 服务 → 刷新清单。
      const onUploadPick = useCallback((e) => {
        const file = e.target.files && e.target.files[0]
        e.target.value = ''
        const key = pendingKeyRef.current
        if (!file || !key || !activePersona) return
        if (!/^image\//.test(file.type)) { setUploadMsg('请选择图片文件'); return }
        const reader = new FileReader()
        reader.onload = async () => {
          const dataUrl = reader.result
          const res = await api(`/${activePersona.id}/portraits/upload`, 'POST', { key, dataUrl })
          setUploadMsg(res.ok
            ? `「${EMOTION_LABELS.find(x => x[0] === key)?.[1] || key}」立绘已上传`
            : '上传失败，请重试')
          const pr = await api(`/${activePersona.id}/portraits`)
          if (pr.ok) setPortraits(pr.portraits || [])
        }
        reader.readAsDataURL(file)
      }, [activePersona])

      const setField = (key) => (e) => setConfig(c => ({ ...c, [key]: e.target.value }))
      const setBool = (key) => (e) => setConfig(c => ({ ...c, [key]: e.target.checked }))
      const setArrayField = (key) => (e) => setConfig(c => ({ ...c, [key]: e.target.value.split('\n').filter(Boolean) }))

      // ── 自定义状态变量表（P1：设置界面可视化编辑）────────────────────
      const customStates = config.customStates || []
      const setVarField = (idx, field) => (e) => {
        const v = e.target.value
        setConfig(c => {
          const arr = (c.customStates || []).map(x => ({ ...x }))
          arr[idx][field] = v
          return { ...c, customStates: arr }
        })
      }
      const addVar = () => {
        setConfig(c => ({ ...c, customStates: [...(c.customStates || []), { key: '', label: '', type: 'meter', def: '' }] }))
      }
      const removeVar = (idx) => {
        setConfig(c => ({ ...c, customStates: (c.customStates || []).filter((_, i) => i !== idx) }))
      }

      const handleSave = async () => {
        setSaving(true)
        saveTavernConfig(config)
        // 保留服务端已存在的 initialState（状态面板用），避免保存设置时被覆盖回默认。
        try {
          const prev = await fetch(`${cfgBase()}/api/tavern/config`)
          if (prev.ok) {
            const prevJ = await prev.json()
            if (prevJ && prevJ.initialState) config.initialState = prevJ.initialState
          }
        } catch { /* 服务器未运行则跳过 */ }
        try {
          const response = await fetch(`${cfgBase()}/api/tavern/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config),
          })
          if (!response.ok) console.warn('[酒馆设置] 同步到服务器失败:', response.status)
          else console.log('[酒馆设置] 配置已同步到服务器')
        } catch (e) {
          console.warn('[酒馆设置] 无法同步到服务器:', e.message)
        }
        setSaving(false)
        setSavedFlash(true)
        setTimeout(() => setSavedFlash(false), 2000)
      }

      const inputStyle = {
        width: '100%', boxSizing: 'border-box',
        padding: '8px 10px', borderRadius: '6px', border: '1px solid rgba(0,0,0,0.12)',
        fontSize: '13px', fontFamily: 'inherit', lineHeight: 1.5,
        background: '#fff', marginTop: '4px',
      }
      const textareaStyle = { ...inputStyle, minHeight: '80px', resize: 'vertical' }
      const labelStyle = { fontSize: '12px', fontWeight: 600, color: '#555', marginTop: '16px', display: 'block' }
      const selectStyle = { ...inputStyle, cursor: 'pointer' }
      const toggleRow = { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '12px' }

      return React.createElement('div', { style: { padding: '16px', fontFamily: 'system-ui, sans-serif' } },
        React.createElement('div', {
          style: {
            padding: '16px', borderRadius: '10px',
            background: 'linear-gradient(135deg, #f5efe8 0%, #e8ddd2 100%)',
            border: '1px solid rgba(216,185,138,0.3)',
            marginBottom: '16px',
          }
        },
          React.createElement('div', { style: { fontSize: '16px', fontWeight: 700, color: '#3d3025', marginBottom: '4px' } }, '酒馆设置'),
          React.createElement('div', { style: { fontSize: '12px', color: '#7a6a58', lineHeight: 1.5 } },
            '配置你的专属酒馆。这些设定会注入到酒馆模式的系统提示中，影响 AI 的扮演表现。'
          ),
        ),

        activePersona
          ? React.createElement('div', {
              style: {
                padding: '10px 14px', borderRadius: '8px',
                background: 'rgba(124,92,252,0.06)',
                border: '1px solid rgba(124,92,252,0.15)',
                marginBottom: '16px',
                fontSize: '13px', color: '#555',
              }
            },
              '当前当班角色: ',
              React.createElement('strong', { style: { color: '#7c5cfc' } }, activePersona.name),
              ' — 去「角色人设」可切换'
            )
          : null,

        // ── 角色立绘 · 手动生成入口（框架先行）──────────────────────────
        React.createElement('div', {
          style: {
            padding: '14px 16px', borderRadius: '10px', marginBottom: '16px',
            background: 'rgba(124,92,252,0.05)',
            border: '1px solid rgba(124,92,252,0.18)',
          }
        },
          React.createElement('div', { style: { fontSize: '14px', fontWeight: 700, color: '#3d3025', marginBottom: '2px' } }, '角色立绘'),
          React.createElement('div', { style: { fontSize: '11px', color: '#888', lineHeight: 1.5, marginBottom: '10px' } },
            activePersona
              ? `为「${activePersona.name}」生成多表情立绘，会显示在酒馆状态栏右上角（随情绪切换）。需已配置 NVIDIA_API_KEY 与额度。`
              : '先生成/激活一个角色人设，再为它生成立绘。'
          ),
          activePersona
            ? React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px' } },
                EMOTION_LABELS.map(([key, label]) =>
                  React.createElement('div', { key: key, style: { display: 'flex', alignItems: 'center', gap: '4px' } },
                    portraitBtn(label, {
                      has: portraits.includes(`${key}.png`),
                      running: generating === key,
                      disabled: !!generating,
                      onClick: () => genPortraits(key),
                    }),
                    React.createElement('button', {
                      type: 'button',
                      onClick: () => { pendingKeyRef.current = key; if (uploadInputRef.current) uploadInputRef.current.click() },
                      title: `上传「${label}」立绘`,
                      style: {
                        padding: '6px 8px', borderRadius: '6px',
                        border: '1px solid rgba(0,0,0,0.15)', background: '#fff', color: '#555',
                        fontSize: '12px', cursor: 'pointer',
                      },
                    }, '⇪'),
                  )
                ),
              )
            : null,
          React.createElement('input', {
            ref: uploadInputRef,
            type: 'file',
            accept: 'image/*',
            style: { display: 'none' },
            onChange: onUploadPick,
          }),
          uploadMsg
            ? React.createElement('div', { style: { marginTop: '8px', fontSize: '11px', color: '#16a34a', fontWeight: 600 } }, uploadMsg)
            : null,
          activePersona
            ? React.createElement('div', { style: { marginTop: '10px', display: 'flex', alignItems: 'center', gap: '10px' } },
                React.createElement('button', {
                  type: 'button',
                  onClick: () => genPortraits(null),
                  disabled: !!generating,
                  style: {
                    padding: '6px 14px', borderRadius: '6px', border: '1px solid rgba(124,92,252,0.4)',
                    background: '#7c5cfc', color: '#fff', fontSize: '12px', fontWeight: 700,
                    cursor: generating ? 'default' : 'pointer',
                  },
                }, generating === 'all' ? '批量生成中…' : '批量生成全部 7 张'),
              )
            : null,
          drawingNote
            ? React.createElement('div', { style: { marginTop: '8px', fontSize: '11px', color: generating ? '#7c5cfc' : '#16a34a', fontWeight: 600 } }, drawingNote)
            : null,
        ),

        React.createElement('label', { style: labelStyle }, '酒馆名称'),
        React.createElement('input', {
          style: inputStyle, value: config.tavernName, onChange: setField('tavernName'),
          placeholder: '例如：深夜小酒馆、月光酒吧',
        }),

        React.createElement('label', { style: labelStyle }, '世界书设定'),
        React.createElement('div', { style: { fontSize: '11px', color: '#888', marginBottom: '4px' } },
          '描述酒馆的世界观、背景故事、地理位置、时间年代等。这会帮助 AI 更好地代入场景。'
        ),
        React.createElement('textarea', {
          style: { ...textareaStyle, minHeight: '100px' },
          value: config.worldBook || '',
          onChange: setField('worldBook'),
          placeholder: '例如：这是一家开在街角的小酒馆，只在深夜营业，老板是个神秘的人物...',
        }),

        React.createElement('label', { style: labelStyle }, '氛围描述'),
        React.createElement('div', { style: { fontSize: '11px', color: '#888', marginBottom: '4px' } },
          '酒馆的氛围、装饰、音乐、气味等感官细节。'
        ),
        React.createElement('textarea', {
          style: { ...textareaStyle, minHeight: '60px' },
          value: config.atmosphere || '',
          onChange: setField('atmosphere'),
          placeholder: '例如：昏暗的灯光、爵士乐、木质吧台、空气中飘着威士忌的香气...',
        }),

        React.createElement('label', { style: labelStyle }, '酒馆开场白'),
        React.createElement('div', { style: { fontSize: '11px', color: '#888', marginBottom: '4px' } },
          '每次进入酒馆模式时老板说的第一句话。'
        ),
        React.createElement('textarea', {
          style: { ...textareaStyle, minHeight: '50px' },
          value: config.greeting || '',
          onChange: setField('greeting'),
          placeholder: '例如：欢迎光临，今晚想喝点什么？',
        }),

        React.createElement('label', { style: labelStyle }, '酒馆规则（每行一条）'),
        React.createElement('div', { style: { fontSize: '11px', color: '#888', marginBottom: '4px' } },
          '必须遵守的硬性规则，AI 不可违反。'
        ),
        React.createElement('textarea', {
          style: { ...textareaStyle, minHeight: '60px' },
          value: (config.rules || []).join('\n'),
          onChange: setArrayField('rules'),
          placeholder: '老板必须始终保持角色\n禁止讨论现实世界的技术话题',
        }),

        React.createElement('div', { style: { marginTop: '20px' } },
          React.createElement('div', { style: { fontSize: '13px', fontWeight: 600, color: '#555', marginBottom: '8px' } }, '记忆设置'),

          React.createElement('div', { style: toggleRow },
            React.createElement('input', {
              type: 'checkbox',
              id: 'autoMemory',
              checked: config.autoMemory,
              onChange: setBool('autoMemory'),
              style: { width: '16px', height: '16px', cursor: 'pointer' },
            }),
            React.createElement('label', {
              htmlFor: 'autoMemory',
              style: { fontSize: '13px', cursor: 'pointer' }
            }, '自动保存记忆（对话中重要信息会自动存储）'),
          ),
        ),
        config.autoMemory
          ? React.createElement('div', { style: toggleRow },
              React.createElement('label', { htmlFor: 'memoryDecay', style: { fontSize: '13px' } }, '记忆衰减速度:'),
              React.createElement('select', {
                id: 'memoryDecay',
                value: config.memoryDecay,
                onChange: setField('memoryDecay'),
                style: { ...selectStyle, width: 'auto', minWidth: '120px' },
              },
                React.createElement('option', { value: 'fast' }, '快（遗忘迅速）'),
                React.createElement('option', { value: 'normal' }, '正常'),
                React.createElement('option', { value: 'slow' }, '慢（记忆持久）'),
              ),
            )
          : null,

        // ── 自定义状态变量表（P1）──────────────────────────────────────
        React.createElement('div', { style: {
            marginTop: '20px', padding: '14px 16px', borderRadius: '10px',
            background: 'rgba(124,92,252,0.05)',
            border: '1px solid rgba(124,92,252,0.18)',
          } },
          React.createElement('div', { style: { fontSize: '14px', fontWeight: 700, color: '#3d3025', marginBottom: '2px' } }, '自定义状态变量'),
          React.createElement('div', { style: { fontSize: '11px', color: '#888', lineHeight: 1.5, marginBottom: '10px' } },
            '声明你要额外追踪的状态，AI 会在每次回复的【状态更新】里按这些键记账，并实时显示在状态栏。' +
            '类型：进度条(0~100) / 计数(可累加) / 文本(直接覆盖)。'
          ),
          customStates.length === 0
            ? React.createElement('div', { style: { fontSize: '12px', color: '#a89a8c', marginBottom: '10px' } },
                '还没有变量。点下方「添加变量」开始建立你的变量表。')
            : React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '10px' } },
                customStates.map((v, idx) =>
                  React.createElement('div', {
                    key: idx,
                    style: {
                      display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap',
                      padding: '8px 10px', borderRadius: '8px', background: '#fff',
                      border: '1px solid rgba(0,0,0,0.1)',
                    }
                  },
                    React.createElement('input', {
                      value: v.key,
                      onChange: setVarField(idx, 'key'),
                      placeholder: '键名',
                      title: 'AI 在【状态更新】里使用的键（例如 营业时间）',
                      style: { ...inputStyle, width: '110px', marginTop: 0 },
                    }),
                    React.createElement('input', {
                      value: v.label,
                      onChange: setVarField(idx, 'label'),
                      placeholder: '显示名',
                      title: '状态栏里显示的名字（留空则用键名）',
                      style: { ...inputStyle, width: '90px', marginTop: 0 },
                    }),
                    React.createElement('select', {
                      value: v.type,
                      onChange: setVarField(idx, 'type'),
                      style: { ...selectStyle, width: 'auto', minWidth: '86px', marginTop: 0, padding: '6px 8px' },
                    },
                      React.createElement('option', { value: 'meter' }, '进度条'),
                      React.createElement('option', { value: 'counter' }, '计数'),
                      React.createElement('option', { value: 'text' }, '文本'),
                    ),
                    React.createElement('input', {
                      value: v.def || '',
                      onChange: setVarField(idx, 'def'),
                      placeholder: '默认值',
                      title: '初始化值（计数默认 0，进度条默认 0）',
                      style: { ...inputStyle, width: '70px', marginTop: 0 },
                    }),
                    React.createElement('button', {
                      type: 'button',
                      onClick: () => removeVar(idx),
                      title: '删除该变量',
                      style: {
                        padding: '4px 8px', borderRadius: '6px', border: '1px solid rgba(0,0,0,0.15)',
                        background: '#fef2f2', color: '#b91c1c', fontSize: '13px',
                        cursor: 'pointer', lineHeight: 1,
                      },
                    }, '✕'),
                  )
                )
              ),
          React.createElement('button', {
            type: 'button',
            onClick: addVar,
            style: {
              padding: '6px 14px', borderRadius: '6px', border: '1px dashed rgba(124,92,252,0.5)',
              background: '#fff', color: '#7c5cfc', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
            },
          }, '+ 添加变量'),
        ),

        React.createElement('div', { style: { marginTop: '20px', display: 'flex', alignItems: 'center', gap: '12px' } },
          React.createElement('button', {
            onClick: handleSave,
            disabled: saving,
            style: {
              padding: '8px 24px', borderRadius: '6px', border: 'none',
              background: saving ? '#ccc' : '#7c5cfc', color: '#fff',
              fontSize: '14px', fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer',
              opacity: saving ? 0.7 : 1,
            }
          }, saving ? '保存中...' : '保存酒馆设置'),
          savedFlash
            ? React.createElement('span', { style: { fontSize: '12px', color: '#16a34a', fontWeight: 600 } }, '✓ 已保存')
            : null,
        ),
      )
    }

    // ── 浏览器端路径工具（工作区路径拼接，不依赖 node:path）────────────────────
    function joinPath(...segments) {
      return segments.filter(s => s && typeof s === 'string').join('/').replace(/\\\\/g, '/')
    }
    function pathBasename(p) {
      if (!p || typeof p !== 'string') return ''
      return p.replace(/\\\\/g, '/').split('/').filter(Boolean).pop() || ''
    }

    // ── openTavern entry logic (自携带，不再触碰 ui-sidebar) ────────────────

    async function openTavern(ctx) {
      try {
        const TAVERN_WORKSPACE_TITLE = '酒馆专属模式'
        // 工作区路径不再写死 C 盘：优先从 config 服务取回 dataDir（= .dsh/.agent-presets/tavern，
        // 位于项目当前目录，符合"配置存当前目录、避免跨盘 junction"约束）；服务不可达时回退为 null，
        // 由下方改用注册过的现有工作区或跳过创建（绝不在前端硬编码家目录路径）。
        let TAVERN_PARENT_PATH = null
        try {
          const res = await fetch(`${cfgBase()}/api/tavern/config`, { signal: AbortSignal.timeout(4000) })
          if (res.ok) {
            const j = await res.json()
            if (j && typeof j.dataDir === 'string' && j.dataDir) TAVERN_PARENT_PATH = j.dataDir
          }
        } catch { /* config 服务未运行，见下方回退 */ }
        const TAVERN_WORKSPACE_PATH = TAVERN_PARENT_PATH ? joinPath(TAVERN_PARENT_PATH, 'workspace') : null

        const workspaces = ctx.workspaces.list.getSnapshot()
        let tavernWorkspace = workspaces.items.find(w => w.title === TAVERN_WORKSPACE_TITLE)
        // 兼容历史：若旧版已在工作区列表注册过该路径/标题，直接复用，不重建。
        if (!tavernWorkspace) {
          tavernWorkspace = TAVERN_WORKSPACE_PATH
            ? workspaces.items.find(w => w.path === TAVERN_WORKSPACE_PATH)
            : workspaces.items.find(w => w.title === TAVERN_WORKSPACE_TITLE)
          if (tavernWorkspace && TAVERN_WORKSPACE_TITLE) {
            await ctx.workspaces.rename(tavernWorkspace.workspaceId, TAVERN_WORKSPACE_TITLE).catch(() => {})
            tavernWorkspace = { ...tavernWorkspace, title: TAVERN_WORKSPACE_TITLE }
          } else if (TAVERN_WORKSPACE_PATH && TAVERN_PARENT_PATH) {
            try {
              await ctx.workspaces.createDirectory(TAVERN_PARENT_PATH, pathBasename(TAVERN_WORKSPACE_PATH))
            } catch { /* dir may already exist */ }
            const created = await ctx.workspaces.create({ path: TAVERN_WORKSPACE_PATH })
            await ctx.workspaces.rename(created.workspaceId, TAVERN_WORKSPACE_TITLE)
            tavernWorkspace = { ...created, title: TAVERN_WORKSPACE_TITLE }
          }
        }
        // 连 config 服务都拿不到 dataDir 且没有现存工作区时，放弃创建（避免写到不确定位置）。
        if (!tavernWorkspace) {
          console.warn('[tavern] 无法确定酒馆工作区路径（config 服务不可达），已跳过创建')
          ctx.sessions.list.getSnapshot() // 触发一次读取以保持流程可继续
          const actx = ctx.sessions.scope?.(ctx.sessions.list.getSnapshot()?.focusId)
            ?? ctx.sessions.scope?.(Object.keys(ctx.sessions.list.getSnapshot()?.byId || {})[0])
          actx?.get?.('conversation')?.input?.for?.(actx)?.notify?.('error', '酒馆工作区初始化失败：config 服务未运行')
          return
        }

        const conn = ctx.get('connection')
        const sessionId = await ctx.workspaces.connectWorkspace(tavernWorkspace.workspaceId)

        ctx.sessions.noteAgentPreset(sessionId, 'tavern')

        const applied = await conn.api.agentPresets.select({ sessionId, agentPreset: 'tavern' })
        if (applied.result.ok) {
          ctx.sessions.noteAgentPreset(sessionId, applied.result.value.agentPreset)
        } else {
          const message = `酒馆模式预设未生效：${applied.result.error.message}`
          console.warn('[tavern] select did not return ok — persona/memory injection may be absent', applied.result)
          const actx = ctx.sessions.scope(sessionId)
          const conversation = actx?.get('conversation')
          conversation?.input?.for(actx)?.notify('error', message)
        }

        ctx.sessions.open(sessionId)
      } catch (e) {
        console.error('[tavern] create/select/open failed', e)
      }
    }

    // ── Footer entry (sidebar.footer.action) ───────────────────────────────

    function TavernFooterAction({ wide, ctx }) {
      const iconStyle = {
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: 'none', background: 'transparent', cursor: 'pointer',
        borderRadius: '6px', color: '#d8b98a',
        width: wide ? 'auto' : '36px', height: '36px', padding: wide ? '0 10px' : '0',
        fontSize: wide ? '13px' : '18px', gap: '6px', fontWeight: 600,
      }
      return React.createElement('button', {
        type: 'button',
        'aria-label': '酒馆模式',
        title: '酒馆模式',
        onClick: () => { openTavern(ctx) },
        style: iconStyle,
      },
        React.createElement('span', null, '🏮'),
        wide ? React.createElement('span', null, '酒馆') : null,
      )
    }

    exports.inject = ['slots', 'workspaces', 'sessions', 'layout', 'connection']
    exports.apply = function (ctx) {
      // 酒馆设置 settings section
      ctx.effect(() =>
        ctx.slots.inject('settings.section', function* () {
          yield ctx.slots.register(
            { name: 'settings.section', id: 'dsh-tavern', order: 35, label: '酒馆设置' },
            TavernSettingsEditor,
          )
        }),
        'dsh-tavern: settings card',
      )
      // 酒馆会话输入区上方卡片。挂在 conversation.input.dock（hero 与 active
      // 模式均渲染，避免空白会话看不到卡片），由 TavernPanel 依据 agentPreset
      // 自门控：普通会话渲染空、不占用布局。
      ctx.effect(() =>
        ctx.slots.inject('conversation.input.dock', function* () {
          yield ctx.slots.register(
            { name: 'conversation.input.dock', id: 'dsh-tavern', order: 30 },
            (props) => React.createElement(TavernPanel, { ...props, ctx }),
          )
        }),
        'dsh-tavern: input dock card',
      )
      // 侧边栏底部酒馆入口
      ctx.effect(() =>
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            { name: 'sidebar.footer.action', id: 'dsh-tavern', order: 10 },
            (props) => React.createElement(TavernFooterAction, { ...props, ctx }),
          ),
        ),
        'dsh-tavern: footer action',
      )
    }

    // 纯函数导出（供 Node 单测直接消费，不影响运行时）。
    exports.parseToolStateMarker = parseToolStateMarker
    exports.applyToolState = applyToolState

    return module.exports
  }
})
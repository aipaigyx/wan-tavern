/**
 * wan-tavern 安装脚本
 *
 * 职责：把插件内置的 agent preset (presets/tavern) 部署到目标 DSH 实例的
 * `.dsh/.agent-presets/tavern` 目录里，让 DSH 启动后自动识别「酒馆模式」。
 *
 * 用法：
 *   # 交互式：脚本会扫描本插件父目录的上层是否已有 DSH 项目
 *   node install.mjs preset
 *
 *   # 显式指定目标 DSH 根目录（包含 .dsh 子目录的那一层）
 *   node install.mjs preset --target D:/path/to/deepseek-harness
 *
 *   # 复制到 DSH Desktop 的用户数据目录
 *   node install.mjs preset --target "%APPDATA%/dsh/User"
 *
 *   # 仅拷贝 preset 而不覆盖已有的 config.json / state/
 *   node install.mjs preset --target <dir> --skip-config
 */

import { existsSync, mkdirSync, readFileSync, copyFileSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve, relative, basename, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PRESET_SRC = join(__dirname, 'presets', 'tavern')
const PLUGIN_PKG = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'))

function log(...args) { console.log('[wan-tavern]', ...args) }
function warn(...args) { console.warn('[wan-tavern][warn]', ...args) }

/** 递归收集目录下所有文件（返回绝对路径数组）。 */
function walk(dir, out = []) {
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.isFile()) out.push(p)
  }
  return out
}

/** 查找本机可能存在的 DSH 根目录（包含 .dsh 子目录）。 */
function discoverTargets() {
  const candidates = []
  // 1. 本插件所在位置往上爬（vendor / 工作副本场景）
  let cur = __dirname
  for (let i = 0; i < 5; i++) {
    candidates.push(cur)
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  // 2. 常见的 DSH Desktop 用户数据位置
  if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'dsh', 'User'))
  if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'dsh', 'User'))
  candidates.push(join(homedir(), '.dsh'))
  candidates.push(join(homedir(), 'Documents', 'dsh'))
  // 3. 通用：用户主目录下的 deepseek-harness 类似目录
  const home = homedir()
  for (const name of ['deepseek-harness', 'deepseek-harness-master', 'dsh-project']) {
    candidates.push(join(home, name))
    candidates.push(join(home, 'Desktop', name))
    candidates.push(join(home, 'Documents', name))
  }
  // 去重 + 校验
  const out = []
  const seen = new Set()
  for (const c of candidates) {
    const norm = resolve(c)
    if (seen.has(norm)) continue
    seen.add(norm)
    if (existsSync(join(c, '.dsh'))) out.push(norm)
  }
  return out
}

function parseArgs(argv) {
  const args = { cmd: argv[0], target: null, skipConfig: false, yes: false }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--target' && argv[i + 1]) { args.target = argv[++i]; continue }
    if (a === '--skip-config') { args.skipConfig = true; continue }
    if (a === '--yes' || a === '-y') { args.yes = true; continue }
  }
  return args
}

function installPreset({ target, skipConfig, yes }) {
  const dshDir = join(target, '.dsh')
  if (!existsSync(dshDir)) {
    console.error(`[wan-tavern] 目标目录不含 .dsh 子目录：${target}`)
    console.error('请确认这是 DSH 项目根或 DSH Desktop 用户数据目录，或改用 --target 显式指定。')
    return 2
  }
  const presetRoot = join(dshDir, '.agent-presets')
  const dest = join(presetRoot, 'tavern')
  mkdirSync(dest, { recursive: true })

  log(`将把 preset 部署到：${dest}`)
  if (existsSync(dest)) {
    const existingFiles = walk(dest)
    if (existingFiles.length > 0) {
      log(`目标 preset 已存在 ${existingFiles.length} 个文件，将按规则覆盖/保留。`)
      if (!yes) log('（可用 --yes 关闭此提示；config.json / state/* 默认不会覆盖）')
    }
  }

  // 拷贝 preset 资源（除 config.json / state 外都强制覆盖）
  const files = walk(PRESET_SRC)
  for (const abs of files) {
    const rel = relative(PRESET_SRC, abs)
    const outPath = join(dest, rel)
    mkdirSync(dirname(outPath), { recursive: true })
    // 判断是否为用户数据（保留用户历史）
    const normalized = rel.split(sep).join('/')
    const isUserData = normalized === 'config.json' || normalized.startsWith('state/')
    if (isUserData && skipConfig) {
      log(`  跳过用户数据：${rel}`)
      continue
    }
    if (isUserData && existsSync(outPath)) {
      log(`  保留已有用户数据：${rel}（如需重置，先手动删除该文件再重试）`)
      continue
    }
    copyFileSync(abs, outPath)
    log(`  写入：${rel}`)
  }

  // 写入 version 标记，便于用户诊断自己用的是哪一版 preset
  const stamp = {
    plugin: PLUGIN_PKG.name,
    version: PLUGIN_PKG.version,
    installedAt: new Date().toISOString(),
    tavernPreset: '1.0',
  }
  writeFileSync(join(dest, '.install-info.json'), JSON.stringify(stamp, null, 2))
  log(`✓ preset 安装完成：${dest}`)

  // 若发现目标目录下已有 package.json（DSH 项目根），顺便把插件自己登记进去
  const pkgPath = join(target, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      const deps = pkg.dependencies || (pkg.dependencies = {})
      if (!pkg.dsh) pkg.dsh = {}
      if (!pkg.dsh.profile) pkg.dsh.profile = {}
      const bundles = pkg.dsh.profile.bundles || (pkg.dsh.profile.bundles = [])
      const pluginPath = resolve(__dirname)
      const fileRef = `file:${pluginPath.replace(/\\/g, '/')}`
      if (deps[PLUGIN_PKG.name] && typeof deps[PLUGIN_PKG.name] === 'string' && deps[PLUGIN_PKG.name].startsWith('file:')) {
        log(`  目标 package.json 已登记 ${PLUGIN_PKG.name}，无需重复添加。`)
      } else {
        deps[PLUGIN_PKG.name] = fileRef
        if (!bundles.includes(PLUGIN_PKG.name)) bundles.push(PLUGIN_PKG.name)
        writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))
        log(`  已把 ${PLUGIN_PKG.name} 登记进 ${pkgPath}`)
      }
    } catch (e) {
      warn(`  自动登记到 package.json 失败：${e && e.message || e}`)
    }
  } else {
    log(`  目标无 package.json，未自动登记依赖；若为 DSH Desktop，这是正常情况。`)
  }

  return 0
}

// 入口
const argv = process.argv.slice(2)
const parsed = parseArgs(argv)
if (parsed.cmd === 'preset') {
  let target = parsed.target
  if (!target) {
    const found = discoverTargets()
    if (found.length === 0) {
      console.error('[wan-tavern] 未能自动定位 DSH 根目录，请用 --target 显式指定。')
      console.error('示例：node install.mjs preset --target D:/path/to/your/dsh')
      process.exit(2)
    }
    if (found.length === 1) {
      target = found[0]
      log(`自动发现 DSH 根目录：${target}`)
    } else {
      console.error('[wan-tavern] 发现多个可能的 DSH 目录，请用 --target 指定：')
      for (const f of found) console.error('  ' + f)
      process.exit(2)
    }
  }
  const code = installPreset({ target: resolve(target), skipConfig: parsed.skipConfig, yes: parsed.yes })
  process.exit(code || 0)
} else {
  console.log('用法：')
  console.log('  node install.mjs preset [--target <dsh-root>] [--skip-config]')
  console.log('')
  console.log('选项：')
  console.log('  --target <dir>   目标 DSH 根目录（包含 .dsh 子目录）')
  console.log('  --skip-config    不覆盖已存在的 config.json / state/*')
  console.log('  --yes / -y       跳过覆盖确认提示')
  process.exit(0)
}

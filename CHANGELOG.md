# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-08-20

### 🐛 Fixed

- **修复插件安装失败**：添加 `index.js` 作为 DSH Cordis 标准入口（之前仅有 `entry.js`，部分 DSH 版本无法识别）
- **修复 `cordis.patch.yml` name 字段**：改为 `name: wan-tavern`（npm 包名），`id: dsh-tavern`（兼容旧用户），否则 Cordis 按 name import 包时会报 `Cannot find package`
- **修复 `package.json` main 入口**：从 `"main": "entry.js"` 改为 `"main": "index.js"`，对齐 DSH 插件规范
- **移除不存在的 inject 依赖**：删除 `@deepseek-ai/dsh-api-remotes`（该包不存在于 DSH 依赖树）
- **补全 `files` 列表**：添加 `index.js`、`panel.html`、`screenshots/`、`README-TAVERN.md`

### ✨ Added

- 新增 `panel.html`：独立的酒馆设置面板，支持基本信息、自定义变量表、记忆系统、诊断信息可视化配置
- 新增 `screenshots/` 目录：包含 3 张项目截图用于文档展示

### 📁 Files (v1.0.1)

```
wan-tavern/
├── index.js                  # ✨ 新增 DSH Cordis 标准入口
├── entry.js                  # 保留（兼容性）
├── client.js
├── panel.html                # ✨ 新增独立设置面板
├── cordis.patch.yml          # 已修复 name: wan-tavern
├── install.mjs
├── package.json              # 已修复 main/files/inject
├── README.md
├── README-TAVERN.md
├── CHANGELOG.md
├── LICENSE
├── screenshots/             # ✨ 新增截图目录
│   ├── tavern-status-bar.png
│   ├── tavern-settings.png
│   └── tavern-chat.png
├── presets/
│   └── tavern/
│       ├── agent.cordis.yml
│       ├── tavern-config-plugin.mjs
│       ├── preset.yml
│       ├── config.json
│       ├── README-TAVERN.md
│       └── state/default.json
└── tests/
    └── tool-state.test.mjs
```

## [1.0.0] - 2026-08-20

### ✨ Added

- **初始版本**：酒馆模式插件首次发布
- 🍺 完整酒馆体验：侧边栏入口、专属会话卡片、立绘、状态栏
- 🎭 立绘情绪系统：正方形立绘、居中破窗效果、情绪边框
- 📊 记账式状态管理：`manage_tavern_state` 工具 + 服务端原子写
- 🧠 跨模式全局记忆扫描器：无论酒馆还是标准模式都能捕获 `【记忆】` 标记
- 🔧 可视化酒馆设置：世界设定 / 自定义状态变量表编辑器
- 🛡️ 配置防腐层 + 损坏自愈：last-good 备份回退
- 🩺 诊断面板：API 基址、配置来源、状态权威源
- 🔌 零侵入 DSH：所有改动在插件内部，不修改核心代码
- 📦 一键安装脚本 `install.mjs`：自动发现 DSH 根目录、部署 preset、登记依赖

### 🔧 Changed

- `applyToolState` 改为合并语义：`s.custom = { ...(prev.custom || {}), ...out }`，新 payload 仅覆盖对应键，保留已有字段
- `openTavern` 工作区路径由后端 `dataDir` 动态派生，不再硬编码 C 盘路径
- `dshPort()` 实现 4 层探测链（DSH 注入 → 用户配置 → 同源推导 → 兜底默认）

### 🐛 Fixed

- 修复 `custom` 字段完全覆盖问题（导致未出现在 payload 中的字段丢失）
- 修复 `scanForTavern` 节点获取逻辑：支持 `snap.legacy.nodes` / `snap.chat.nodes` / `snap.nodes` / `snap.messages` 多种结构
- 修复 config 服务同源推导 bug（端口 3080 vs 3081）
- 修复立绘 `ERR_SSL_PROTOCOL_ERROR`（`pointerEvents: 'none'` 阻止 hover 事件）
- 修复 `joinPath` / `pathBasename` 未定义错误
- 修复 `apiBase()` 返回 HTTPS 导致 SSL 错误

### 📁 Files

```
wan-tavern/
├── entry.js
├── client.js
├── cordis.patch.yml
├── install.mjs
├── package.json
├── README.md
├── CHANGELOG.md
├── LICENSE
├── presets/
│   └── tavern/
│       ├── agent.cordis.yml
│       ├── tavern-config-plugin.mjs
│       ├── preset.yml
│       ├── config.json
│       ├── README-TAVERN.md
│       └── state/default.json
└── tests/
    └── tool-state.test.mjs
```

### 🧪 Tests

- `parseToolStateMarker`: 6 tests ✅
- `applyToolState`: 7 tests ✅
- Total: **13/13 pass**

## [0.0.0] - 2026-08-19

### 🚧 Work in Progress

- M0 基线快照与文档化
- M1~M9 各阶段优化与修复

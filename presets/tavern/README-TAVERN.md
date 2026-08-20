<div align="center">

# 🍻 酒馆模式（Tavern）使用手册

**深夜小酒馆，老板娘倚着吧台等你。进来的人，她都记得——你爱喝什么、上次聊到哪、什么时候会脸红。**

[![Author](https://img.shields.io/badge/author-%E6%98%9F%E8%90%8CMS%E5%B0%8F%E9%83%AD%E9%85%B1-pink.svg)](https://space.bilibili.com/12644772)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![DSH](https://img.shields.io/badge/DSH-compatible-8A2BE2.svg)](https://github.com/deepseek-ai/deepseek-harness)

</div>

---

## 📖 目录

- [⚡ 快速上手](#-快速上手)
  - [环境要求](#环境要求)
  - [一条命令启动](#一条命令启动)
- [✨ 功能概览](#-功能概览)
- [🔧 配置说明](#-配置说明)
  - [config.json 配置项](#configjson-配置项)
  - [自定义变量类型](#自定义变量类型)
  - [变量表编辑器](#变量表编辑器)
- [🧠 记忆系统](#-记忆系统)
  - [三层记忆架构](#三层记忆架构)
  - [触发方式](#触发方式)
  - [记忆写入流程](#记忆写入流程)
  - [记忆衰减策略](#记忆衰减策略)
  - [跨模式共享](#跨模式共享)
  - [状态栏记忆区块](#状态栏记忆区块)
  - [记忆 API](#记忆-api)
- [🖥️ 状态栏](#️-状态栏)
  - [完整版](#完整版)
  - [折叠展开](#折叠展开)
  - [营业时长](#营业时长)
- [🩺 诊断面板](#-诊断面板)
- [❓ 常见问题](#-常见问题)
- [📋 默认配置速查](#-默认配置速查)
- [🏗️ 文件结构](#️-文件结构)
- [📚 相关文档](#-相关文档)
- [🤝 作者](#-作者)

---

## ⚡ 快速上手

### 环境要求

| 依赖 | 版本要求 | 说明 |
|------|----------|------|
| [Node.js](https://nodejs.org/) | ≥ 22.19.0 | DSH 引擎运行时 |
| [pnpm](https://pnpm.io/) | ≥ 11.7.0 | 包管理器（项目指定） |
| 模型 API Key | — | 在 DSH 设置中配置（SiliconFlow / NVIDIA 等） |
| [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | ≥ 最新 commit | 宿主框架 |

### 一条命令启动

```bash
# 1. 构建项目（首次或代码变更后）
pnpm run build

# 2. 启动 DSH Web 服务
pnpm dsh web
```

启动成功后，浏览器访问 `http://localhost:3080`，左侧边栏底部点击 **🍻 酒馆模式** 即可进入。

> **📍 配置存储路径**：配置文件全部存储在项目当前目录的 `.dsh/.agent-presets/tavern/` 下，**不会写入 C 盘系统目录**。这符合「配置存当前目录、避免跨盘 junction」的约束。

---

## ✨ 功能概览

| 功能 | 说明 |
|------|------|
| 🍺 **纯对话体验** | 无代码、无工具的沉浸式角色扮演，AI 以老板娘身份自然对话 |
| 🧠 **记忆系统** | 自动记录客人的喜好与过往，下次进入仍记得你 |
| 📊 **状态栏** | 实时展示场景、时间、情绪、亲密度、好感度、信任度等状态 |
| 🎨 **立绘情绪系统** | 正方形立绘、居中破窗效果、情绪边框颜色随状态变化 |
| ⚙️ **自定义变量** | 可在酒馆设置中添加专属状态变量（计数器 / 进度条 / 文本） |
| 🎛️ **设置面板** | 酒馆名称、世界观、氛围、规则、记忆衰减等均可自定义 |
| 🩺 **诊断面板** | 一键展示 API 基址、配置来源、连接状态，报障有据可查 |
| 🔌 **工具调用** | `manage_tavern_state` 工具 + 服务端原子写的状态权威源 |
| 🌐 **跨模式记忆** | 全局记忆扫描器捕获 `【记忆】` 标记，标准模式下也能写入 |

---

## 🔧 配置说明

### config.json 配置项

配置文件路径：`.dsh/.agent-presets/tavern/config.json`

```json
{
  "tavernName": "深夜小酒馆",
  "worldBook": "",
  "atmosphere": "",
  "autoMemory": true,
  "memoryDecay": "normal",
  "greeting": "",
  "rules": [],
  "customStates": [
    { "key": "接客数", "label": "接客", "type": "counter", "def": "0" },
    { "key": "兴奋度", "label": "兴奋", "type": "meter", "def": "" }
  ],
  "initialState": {
    "scene": "深夜小酒馆吧台旁",
    "time": "深夜",
    "emotion": "平静",
    "intensity": "适中",
    "intimacy": 20,
    "affection": 15,
    "trust": 10
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `tavernName` | string | 酒馆名称，默认「深夜小酒馆」 |
| `worldBook` | string | 世界设定（Markdown 文本，注入系统提示） |
| `atmosphere` | string | 氛围描述 |
| `greeting` | string | 开场白（AI 首次打招呼的参考） |
| `rules` | string[] | 必须遵守的规则列表 |
| `autoMemory` | boolean | 是否自动保存记忆（默认 `true`） |
| `memoryDecay` | string | 记忆衰减策略：`light` / `normal` / `heavy` |
| `customStates` | Array\<{key, label, type, def}\> | 自定义状态变量表 |
| `initialState` | object | 初始状态（scene / time / emotion / intimacy 等） |

### 自定义变量类型

| 类型 | 范围 | 用途 | 示例 |
|------|------|------|------|
| `counter` | ≥ 0 整数 | 计数型，支持 `+N` / `-N` 增量 | 接客数、送礼次数 |
| `meter` | 0~100 | 进度条型，数值化后整数化 | 兴奋度、醉意 |
| `text` | 任意文本 | 文本型，直接覆盖为新字符串 | 当前任务、地点 |

### 变量表编辑器

在酒馆设置面板中可以：

- **新增**：点击「添加变量」，填写键名、显示名、类型、默认值
- **编辑**：直接修改已有变量的任意字段
- **删除**：点击变量右侧的删除按钮

---

## 🧠 记忆系统

酒馆模式内置**三层记忆架构**，自动追踪角色的对话历史与情感变化。

### 三层记忆架构

| 层级 | 名称 | 作用 | 生命周期 |
|------|------|------|----------|
| L1 | **工作记忆** | 当前会话内的上下文对话 | 会话级（关闭即消失） |
| L2 | **长期记忆** | 跨会话持久化的重要记忆（通过 `【记忆】` 标记触发） | 永久 |
| L3 | **背景知识库** | 世界设定、规则、角色档案等静态知识 | 永久 |

### 触发方式

AI 回复中包含 `【记忆】` 标记时，标记后的文本会被自动捕获并写入长期记忆。

**示例**：
```
老板娘轻轻叹了口气：「你上次来的时候喝了三瓶 sake，这次酒量怎么样？」
【记忆】客人偏爱清酒，上次喝了三瓶
```

### 记忆写入流程

```
AI 回复文本
    │
    ▼
extractMemory(text) ──► 识别 【记忆】 标记
    │                         │
    │            不是记忆 ──► 跳过
    │
    ▼
命中 【记忆】 ？
    │
    ▼
┌───────────────────────────────────────┐
│   双路径写入（避免重复）                │
│                                        │
│  路径 A：酒馆模式内                     │
│  scanForTavern() → onMemory 回调        │
│    → handleMemory() → memApi('/add')   │
│                                        │
│  路径 B：全局扫描器（所有模式）          │
│  globalMemoryScanner → seenTexts 去重   │
│    → memApi('/add')                    │
│    （酒馆模式下自动跳过，走路径 A）      │
└───────────────────────────────────────┘
    │
    ▼
记忆 API 持久化存储
```

### 记忆衰减策略

通过 `memoryDecay` 字段控制：

| 策略 | 说明 | 适用场景 |
|------|------|----------|
| `light` | 弱衰减，记忆保留时间短 | 一次性/短期体验 |
| `normal` | 标准衰减（默认） | 日常使用 |
| `heavy` | 强衰减，重要记忆几乎永久保留 | 深度角色养成 |

### 跨模式共享

全局记忆扫描器在**任何会话**都会运行：

- ✅ 标准模式下 AI 回复中的 `【记忆】` 也会被捕获
- ✅ 不同会话间的记忆可以互相引用
- ✅ `seenTexts` Set 做文本级去重，避免重复写入
- ✅ 酒馆模式下自动跳过全局扫描，由专属扫描器负责

### 状态栏记忆区块

状态栏底部有**可滚动的记忆展示区**，实时显示已捕获的记忆条目：

- 按时间倒序排列（最新的在最上方）
- 支持折叠/展开
- 窄屏模式下自动限高

### 记忆 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/memory/{personaId}` | 获取指定角色的全部记忆 |
| POST | `/api/memory/{personaId}/add` | 新增一条记忆 |
| DELETE | `/api/memory/{personaId}/{memoryId}` | 删除指定记忆 |

> **注意**：记忆 API 由 DSH 宿主提供，用户无需单独配置。

---

## 🖥️ 状态栏

### 完整版

场景 | 时间 | 情绪 | 强度 | 亲密度 | 好感度 | 信任度 | 自定义变量（记忆区块可滚动）

### 折叠展开

- 点击 **▾ 收起** → 精简版（仅显示立绘缩略图 + 亲密/好感/信任数值）
- 点击 **▴ 展开** → 完整版
- 窄屏模式下自动限高，聊天记录不会被挤出

### 营业时长

状态栏右侧显示本次进入酒馆的累计时长。

---

## 🩺 诊断面板

在酒馆设置面板底部，点击 **「重新探测」** 可一键采集诊断信息：

| 诊断项 | 含义 | 正常值 |
|--------|------|--------|
| API 基址 | persona 立绘 API 地址 | 显示运行时解析到的地址 |
| 记忆 API 基址 | 记忆系统 API 地址 | 同上 |
| Config 基址 | 配置同步 API 地址 | 同上 |
| 本地变量表 | localStorage 中的变量表数量 | ≥ 0 |
| 本地状态 | localStorage 中的状态版本与数值 | 版本 v1 + 合理范围 |
| config 服务 | 插件内置配置服务连通性 | HTTP 200 |
| 端口探测 | 四层探测链的最终来源 | 预期来源 |

---

## ❓ 常见问题

<details open>
<summary><strong>Q1: 启动后酒馆入口按钮不显示？</strong></summary>

**排查步骤**：
1. 确认 `pnpm run build` 已完成（检查 `apps/web/dist/` 是否存在）
2. 确认 `pnpm dsh web` 正在运行（端口 3080 可访问）
3. 打开浏览器 DevTools Console，查找 `[tavern]` 前缀的日志

</details>

<details>
<summary><strong>Q2: 酒馆设置保存后刷新失效？</strong></summary>

**排查步骤**：
1. 打开诊断面板 → 检查「config 服务」是否显示 `HTTP 200`
2. 检查 `.dsh/.agent-presets/tavern/config.json` 是否被正确写入
3. 若 config.json 损坏，系统会自动回退到 `.backup/config.last-good.json`（查看 Console 日志确认）

</details>

<details>
<summary><strong>Q3: 状态栏不显示自定义变量？</strong></summary>

**排查步骤**：
1. 进入酒馆会话后，确认已点击过酒馆设置面板的「保存」按钮（localStorage 反向同步）
2. 打开诊断面板 → 检查「本地变量表」数量是否正确
3. 若数量为 0：说明 localStorage 未同步，需硬刷新（Ctrl+F5）后重新进入酒馆

</details>

<details>
<summary><strong>Q4: 状态数值在对话中不更新？</strong></summary>

**排查步骤**：
1. 检查 AI 回复中是否包含 `【状态更新】` 标记
2. 确认变量表的 `key` 与 AI 回复中的键名一致（区分中英文、繁简体）
3. 若使用工具调用模式：查看会话日志中是否有 `manage_tavern_state` 工具调用记录

</details>

<details>
<summary><strong>Q5: 端口冲突（EADDRINUSE）？</strong></summary>

**解决**：
1. 确认没有旧的 config-server 进程残留（M3 起已并入 DSH 插件，不需额外进程）
2. 查看 `__DSH_BOOT__` 注入的端口配置（`window.__DSH_BOOT__?.services`）

</details>

<details>
<summary><strong>Q6: 切换端口后酒馆功能异常？</strong></summary>

**排查步骤**：
1. 打开诊断面板 → 检查「API 基址」「Config 基址」是否已更新为新端口
2. 四层探测链优先级：`__DSH_BOOT__` 注入 → 用户配置覆盖 → 同源推导 → 兜底
3. 若兜底端口被使用：在 DSH 设置中配置正确的端口映射

</details>

<details>
<summary><strong>Q7: 立绘 / 立绘破窗效果不显示？</strong></summary>

**排查步骤**：
1. 确认 persona API 可达（诊断面板「API 基址」正常）
2. 确认已激活带立绘的角色人设
3. 窄屏模式下立绘会自动缩小以保证聊天记录可见

</details>

<details>
<summary><strong>Q8: 硬刷新（Ctrl+F5）后状态丢失？</strong></summary>

**说明**：状态存在两处：
- `localStorage`（前端快速读写）→ 硬刷新不丢
- `state/<sessionId>.json`（后端持久化）→ 硬刷新不丢

如果硬刷新后状态清空，检查：
1. 是否切换了浏览器（localStorage 按域隔离）
2. 后端 state 文件是否正常：`.dsh/.agent-presets/tavern/state/<sessionId>.json`

</details>

<details>
<summary><strong>Q9: 跨模式记忆扫描器重复写入？</strong></summary>

**说明**：不会。扫描器内部用 `seenTexts` Set 做去重，且酒馆模式下检测到 `isTavern === true` 会跳过（因为 tavern 自身的扫描器已通过 `onMemory` 回调写入）。

</details>

---

## 📋 默认配置速查

首次进入酒馆模式的默认状态：

| 项目 | 默认值 |
|------|--------|
| 酒馆名称 | 深夜小酒馆 |
| 初始场景 | 深夜小酒馆吧台旁 |
| 初始时间 | 深夜 |
| 初始情绪 | 平静 |
| 亲密度 | 20 |
| 好感度 | 15 |
| 信任度 | 10 |
| 默认变量 | 接客数（计数器）、兴奋度（进度条） |
| 记忆自动开启 | 是 |
| 记忆衰减 | normal |

---

## 🏗️ 文件结构

```
.dsh/.agent-presets/tavern/
├── preset.yml                    # 酒馆预设元数据
├── agent.cordis.yml              # 服务端插件装配（tavern-config + persona）
├── config.json                   # 配置文件（酒馆名称/变量表/初始状态）
├── tavern-config-plugin.mjs      # 配置服务插件（GET/POST /api/tavern/config + manage_tavern_state 工具）
├── README-TAVERN.md              # 本文档
├── tests/
│   └── state-schema.test.mjs     # 状态校验单元测试
├── state/                        # 会话状态持久化目录
│   └── <sessionId>.json          # 按会话分区的状态文件
└── .backup/                      # 配置备份
    └── config.last-good.json     # 上次好配置（自愈来源）

wan-tavern/                       # 插件包（vendored）
├── package.json                  # 插件包元数据
├── entry.js                      # 服务端入口
├── client.js                     # 前端核心（状态栏/设置/诊断面板/记忆扫描）
├── cordis.patch.yml              # 前端注入装配
├── install.mjs                  # 一键安装脚本
└── tests/
    └── tool-state.test.mjs       # 工具状态解析单元测试（13 用例）
```

---

## 📚 相关文档

| 文档 | 内容 |
|------|------|
| [README.md](../../README.md) | 插件主文档（安装、配置、开发者指南） |
| [CHANGELOG.md](../../CHANGELOG.md) | 版本变更日志 |
| [tests/state-schema.test.mjs](tests/state-schema.test.mjs) | 状态迁移与 Schema 校验单元测试 |

---

## 🤝 作者

**B站星萌Y小郭酱**

- 🏠 B站空间：[https://space.bilibili.com/12644772](https://space.bilibili.com/12644772)
- 📮 UID：12644772

本酒馆模式插件由 **B站星萌Y小郭酱** 独立开发维护。

---

<div align="center">

🍻 **Welcome to the Tavern** — 进酒馆的人，老板娘都记得 🍻

</div>

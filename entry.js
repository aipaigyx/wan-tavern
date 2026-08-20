// dsh-tavern server half (minimal placeholder).
// 酒馆模式的服务端逻辑集中在 .dsh/.agent-presets/tavern/ 的独立脚本中
// (tavern-config-plugin.mjs 注入系统提示, config-server.mjs 持久化设置)。
// 此插件仅作为 Cordis bundle 的服务端入口存在。
import z from '@deepseek-ai/schemastery'

export const Config = z.object({})
export const inject = []

export function apply(ctx) {
  ctx.logger?.info?.('[dsh-tavern] loaded')
}
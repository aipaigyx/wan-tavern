/**
 * wan-tavern — DSH Cordis 插件入口。
 *
 * DSH 通过 Cordis 插件机制加载本模块：
 *   - name / inject / apply 为 Cordis 标准导出
 *   - apply 注册酒馆配置 API
 *   - client.js 通过 window.__ModuleLoader__.load({ id: 'dsh-tavern' })
 *     注册浏览器端模块（侧边栏/设置/状态栏/记忆扫描器）
 */
import z from '@deepseek-ai/schemastery'

export const Config = z.object({})

export const name = 'dsh-tavern'

export const inject = ['tools', 'webServer', 'agentDefaultModel', 'attachments']

export function apply(ctx, config = {}) {
  ctx.logger?.info?.('[dsh-tavern] loaded')

  const webServer = ctx.webServer ?? ctx.get('webServer')
  if (webServer) {
    try {
      webServer.register({
        kind: 'exact',
        path: '/api/tavern/config',
        handler(req, res) {
          if (req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              ok: true,
              plugin: 'wan-tavern',
              version: '1.0.0',
              dataDir: process.cwd(),
              message: '酒馆插件已加载'
            }))
          } else if (req.method === 'POST') {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true, message: '配置已保存' }))
          }
        }
      })
      ctx.logger?.info?.('[dsh-tavern] 配置 API 已注册: /api/tavern/config')
    } catch (e) {
      ctx.logger?.warn?.('[dsh-tavern] webServer 注册失败:', e?.message)
    }
  }
}

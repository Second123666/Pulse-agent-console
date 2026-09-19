/* eslint-disable no-console */
import { register } from '../agent/registry'
import { McpClient } from './client'

export interface McpServerConfig {
  name: string
  url: string
}

/**
 * 从配置的 MCP server 拉取工具列表并桥接进 registry。
 * 单个 server 加载失败不影响其他 server（各自 try/catch）。
 */
export async function loadMcpTools(servers: McpServerConfig[]): Promise<number> {
  let bridged = 0
  for (const server of servers) {
    const client = new McpClient(server.url)
    try {
      await client.initialize()
      const tools = await client.listTools()
      for (const tool of tools) {
        register({
          name: tool.name,
          description: tool.description ?? `(MCP: ${server.name})`,
          parameters: tool.inputSchema ?? { type: 'object', properties: {} },
          handler: async args => client.callTool(tool.name, args),
        })
      }
      bridged += tools.length
      console.log(`[mcp] 已桥接 ${server.name}：${tools.length} 个工具`)
    }
    catch (error: any) {
      console.error(`[mcp] ${server.name}（${server.url}）加载失败：${error?.message ?? error}`)
    }
  }
  return bridged
}

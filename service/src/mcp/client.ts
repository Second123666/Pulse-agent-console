// MCP（Model Context Protocol）Streamable HTTP 客户端：JSON-RPC 2.0 over HTTP
// 参考规范：https://modelcontextprotocol.io

export interface McpTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export class McpError extends Error {
  constructor(message: string, public readonly code?: number) {
    super(message)
    this.name = 'McpError'
  }
}

interface JsonRpcResponse {
  jsonrpc: string
  id?: number | string
  result?: any
  error?: { code: number; message: string }
}

export class McpClient {
  private requestId = 0

  constructor(private readonly url: string) {}

  /** 发送 JSON-RPC 请求并解析 JSON 响应 */
  private async request(method: string, params?: Record<string, unknown>, isNotification = false): Promise<any> {
    const payload: Record<string, unknown> = {
      jsonrpc: '2.0',
      method,
    }
    if (!isNotification) {
      payload.id = ++this.requestId
      if (params)
        payload.params = params
    }
    else {
      if (params)
        payload.params = params
    }

    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify(payload),
    })

    if (isNotification)
      return

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new McpError(`MCP 请求失败（HTTP ${response.status}）：${body.slice(0, 200)}`)
    }

    const text = await response.text()
    const data: JsonRpcResponse = JSON.parse(text)
    if (data.error)
      throw new McpError(`MCP 错误（${data.error.code}）：${data.error.message}`, data.error.code)
    return data.result
  }

  /** 握手：获取协议版本与服务端能力 */
  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'pulse-agent', version: '1.0.0' },
    })
    // 通知服务端客户端已就绪
    await this.request('notifications/initialized', {}, true)
  }

  /** 拉取服务端工具列表 */
  async listTools(): Promise<McpTool[]> {
    const result = await this.request('tools/list')
    return (result?.tools ?? []) as McpTool[]
  }

  /** 调用工具并拼接文本内容 */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.request('tools/call', { name, arguments: args })
    const content: Array<{ type?: string; text?: string }> = result?.content ?? []
    const text = content
      .filter(item => item.type === 'text' || typeof item.text === 'string')
      .map(item => item.text ?? '')
      .join('\n')
    return text || '(工具未返回文本内容)'
  }
}

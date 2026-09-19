import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpClient, McpError } from './client'

function jsonResponse(value: unknown) {
  return { ok: true, status: 200, text: async () => JSON.stringify(value) }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('McpClient', () => {
  it('initialize 发送握手并通知已就绪', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: {} } }))
      .mockResolvedValueOnce(jsonResponse({}))
    vi.stubGlobal('fetch', mockFetch)

    const client = new McpClient('http://mcp.example.com/mcp')
    await client.initialize()

    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('http://mcp.example.com/mcp')
    const body = JSON.parse(init.body)
    expect(body.method).toBe('initialize')
    expect(body.id).toBe(1)
    // 第二条是 notifications/initialized
    const notifBody = JSON.parse(mockFetch.mock.calls[1][1].body)
    expect(notifBody.method).toBe('notifications/initialized')
    expect(notifBody.id).toBeUndefined()
  })

  it('listTools 解析工具列表', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      jsonrpc: '2.0',
      id: 2,
      result: { tools: [{ name: 'echo', description: '回显', inputSchema: { type: 'object' } }] },
    })))
    const client = new McpClient('http://x/mcp')
    const tools = await client.listTools()
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('echo')
  })

  it('callTool 拼接文本内容', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      jsonrpc: '2.0',
      id: 3,
      result: { content: [{ type: 'text', text: '结果A' }, { type: 'text', text: '结果B' }] },
    })))
    const client = new McpClient('http://x/mcp')
    const result = await client.callTool('echo', { msg: 'hi' })
    expect(result).toBe('结果A\n结果B')
  })

  it('服务端返回 JSON-RPC 错误时抛出 McpError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32601, message: 'Method not found' },
    })))
    const client = new McpClient('http://x/mcp')
    await expect(client.listTools()).rejects.toThrow(McpError)
  })

  it('HTTP 非 2xx 时抛错', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' }))
    const client = new McpClient('http://x/mcp')
    await expect(client.listTools()).rejects.toThrow('HTTP 500')
  })
})

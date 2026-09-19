import { afterEach, describe, expect, it, vi } from 'vitest'
import { get } from '../agent/registry'
import { loadMcpTools } from './bridge'

function jsonResponse(value: unknown) {
  return { ok: true, status: 200, text: async () => JSON.stringify(value) }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('loadMcpTools', () => {
  it('拉取 MCP 工具并注册进 registry，handler 转发 tools/call', async () => {
    const methods: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body)
      methods.push(body.method)
      if (body.method === 'initialize')
        return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {} } })
      if (body.method === 'notifications/initialized')
        return jsonResponse({})
      if (body.method === 'tools/list')
        return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'mcp_echo', description: '回显', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } })
      if (body.method === 'tools/call')
        return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: `echo:${body.params.arguments.text}` }] } })
      return jsonResponse({})
    }))

    const count = await loadMcpTools([{ name: 'demo', url: 'http://mcp.example.com/mcp' }])
    expect(count).toBe(1)

    const tool = get('mcp_echo')
    expect(tool).toBeDefined()
    expect(tool!.description).toContain('回显')
    const result = await tool!.handler({ text: 'hello' })
    expect(result).toBe('echo:hello')
    expect(methods).toContain('tools/call')
  })

  it('单个 server 连接失败不影响其他（返回 0）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')))
    const count = await loadMcpTools([{ name: 'a', url: 'http://a' }, { name: 'b', url: 'http://b' }])
    expect(count).toBe(0)
  })
})

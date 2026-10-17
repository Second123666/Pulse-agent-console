import { afterEach, describe, expect, it, vi } from 'vitest'
import { webSearch } from './webSearch'

/** DeepSeek Search API 文档形态的响应：{ results: [...] } */
function deepseekResponse(results: unknown[]) {
  return { ok: true, json: async () => ({ results }) }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('webSearch', () => {
  it('未配置 key（SEARCH_API_KEY 与 API_KEY 都缺）时返回说明文本而不是抛错', async () => {
    vi.stubEnv('SEARCH_API_KEY', '')
    vi.stubEnv('API_KEY', '')
    const result = await webSearch.handler({ query: 'test' })
    expect(result).toContain('未配置')
  })

  it('配置 key 时调用 DeepSeek 接口并按契约携带鉴权与参数', async () => {
    vi.stubEnv('SEARCH_API_KEY', 'fake-key')
    const mockFetch = vi.fn().mockResolvedValue(deepseekResponse([
      { title: 'T1', url: 'https://a.com', summary: '摘要A', snippet: '片段A', site_name: '站点A', date: '2026-09-01T00:00:00+08:00' },
      { title: 'T2', url: 'https://b.com', snippet: '片段B' },
    ]))
    vi.stubGlobal('fetch', mockFetch)

    const result = await webSearch.handler({ query: 'hello' })
    expect(result).toContain('T1')
    expect(result).toContain('https://a.com')
    expect(result).toContain('摘要A')
    // summary 优先于 snippet；无 summary 时回退 snippet
    expect(result).toContain('片段B')
    // 站点与日期（取到日）拼一行
    expect(result).toContain('站点A · 2026-09-01')

    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('https://api.deepseek.com/v1/tools/search')
    expect(init.headers.Authorization).toBe('Bearer fake-key')
    const body = JSON.parse(init.body)
    expect(body.query).toBe('hello')
    expect(body.count).toBe(5)
  })

  it('未配置 SEARCH_API_KEY 时回退 API_KEY（同一个 DeepSeek key）', async () => {
    vi.stubEnv('SEARCH_API_KEY', '')
    vi.stubEnv('API_KEY', 'fallback-key')
    const mockFetch = vi.fn().mockResolvedValue(deepseekResponse([]))
    vi.stubGlobal('fetch', mockFetch)

    await webSearch.handler({ query: 'hello' })
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer fallback-key')
  })

  it('SEARCH_API_KEY 优先于 API_KEY（两者都配时）', async () => {
    vi.stubEnv('SEARCH_API_KEY', 'search-key')
    vi.stubEnv('API_KEY', 'chat-key')
    const mockFetch = vi.fn().mockResolvedValue(deepseekResponse([]))
    vi.stubGlobal('fetch', mockFetch)

    await webSearch.handler({ query: 'hello' })
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer search-key')
  })

  it('maxResults 被夹到 1..10 并传给 count', async () => {
    vi.stubEnv('SEARCH_API_KEY', 'fake-key')
    const mockFetch = vi.fn().mockResolvedValue(deepseekResponse([]))
    vi.stubGlobal('fetch', mockFetch)

    await webSearch.handler({ query: 'hello', maxResults: 99 })
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).count).toBe(10)

    await webSearch.handler({ query: 'hello', maxResults: 0 })
    expect(JSON.parse(mockFetch.mock.calls[1][1].body).count).toBe(5)
  })

  it('无结果时返回提示文本', async () => {
    vi.stubEnv('SEARCH_API_KEY', 'fake-key')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(deepseekResponse([])))
    expect(await webSearch.handler({ query: 'hello' })).toContain('未找到')
  })

  it('搜索服务异常时抛错并带出服务端 message（DeepSeek 错误信封）', async () => {
    vi.stubEnv('SEARCH_API_KEY', 'fake-key')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({
        error: { message: 'Authentication Fails, Your api key is invalid', type: 'authentication_error' },
      }),
    }))

    await expect(webSearch.handler({ query: 'hello' }))
      .rejects
      .toThrow('搜索服务返回 HTTP 401：Authentication Fails, Your api key is invalid')
  })

  it('HTTP 异常且 body 不可读时仍能抛错', async () => {
    vi.stubEnv('SEARCH_API_KEY', 'fake-key')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))
    await expect(webSearch.handler({ query: 'hello' })).rejects.toThrow('HTTP 500')
  })

  it('query 为空抛错', async () => {
    await expect(webSearch.handler({ query: '' })).rejects.toThrow('不能为空')
  })
})

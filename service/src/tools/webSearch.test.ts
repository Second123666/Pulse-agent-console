import { afterEach, describe, expect, it, vi } from 'vitest'
import { webSearch } from './webSearch'

/** 博查文档形态的响应：{ data: { webPages: { value } } } */
function bochaResponse(pages: unknown[]) {
  return {
    ok: true,
    json: async () => ({ code: 200, data: { _type: 'SearchResponse', webPages: { value: pages } } }),
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('webSearch', () => {
  it('未配置 key 时返回说明文本而不是抛错', async () => {
    vi.stubEnv('SEARCH_API_KEY', '')
    const result = await webSearch.handler({ query: 'test' })
    expect(result).toContain('未配置')
  })

  it('配置 key 时调用博查接口并按契约携带鉴权与参数', async () => {
    vi.stubEnv('SEARCH_API_KEY', 'fake-key')
    const mockFetch = vi.fn().mockResolvedValue(bochaResponse([
      { name: 'T1', url: 'https://a.com', summary: '摘要A', snippet: '片段A', siteName: '站点A', datePublished: '2026-09-01T00:00:00+08:00' },
      { name: 'T2', url: 'https://b.com', snippet: '片段B' },
    ]))
    vi.stubGlobal('fetch', mockFetch)

    const result = await webSearch.handler({ query: 'hello' })
    expect(result).toContain('T1')
    expect(result).toContain('https://a.com')
    expect(result).toContain('摘要A')
    // summary 优先于 snippet；无 summary 时回退 snippet
    expect(result).toContain('片段B')

    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('https://api.bochaai.com/v1/web-search')
    expect(init.headers.Authorization).toBe('Bearer fake-key')
    const body = JSON.parse(init.body)
    expect(body.query).toBe('hello')
    expect(body.count).toBe(5)
    expect(body.summary).toBe(true)
  })

  it('兼容顶层 webPages 包裹（网关版本差异）', async () => {
    vi.stubEnv('SEARCH_API_KEY', 'fake-key')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ webPages: { value: [{ name: '顶层形态', url: 'https://c.com', snippet: '内容C' }] } }),
    }))

    const result = await webSearch.handler({ query: 'hello' })
    expect(result).toContain('顶层形态')
    expect(result).toContain('内容C')
  })

  it('maxResults 被夹到 1..10 并传给 count', async () => {
    vi.stubEnv('SEARCH_API_KEY', 'fake-key')
    const mockFetch = vi.fn().mockResolvedValue(bochaResponse([]))
    vi.stubGlobal('fetch', mockFetch)

    await webSearch.handler({ query: 'hello', maxResults: 99 })
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).count).toBe(10)

    await webSearch.handler({ query: 'hello', maxResults: 0 })
    expect(JSON.parse(mockFetch.mock.calls[1][1].body).count).toBe(5)
  })

  it('无结果时返回提示文本', async () => {
    vi.stubEnv('SEARCH_API_KEY', 'fake-key')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(bochaResponse([])))
    expect(await webSearch.handler({ query: 'hello' })).toContain('未找到')
  })

  it('搜索服务异常时抛错并带出服务端 message', async () => {
    vi.stubEnv('SEARCH_API_KEY', 'fake-key')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ message: 'Invalid API KEY', code: '401' }),
    }))

    await expect(webSearch.handler({ query: 'hello' }))
      .rejects
      .toThrow('搜索服务返回 HTTP 401：Invalid API KEY')
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

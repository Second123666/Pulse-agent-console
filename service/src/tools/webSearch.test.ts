import { afterEach, describe, expect, it, vi } from 'vitest'
import { webSearch } from './webSearch'

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

  it('配置 key 时调用搜索接口并格式化结果', async () => {
    vi.stubEnv('SEARCH_API_KEY', 'fake-key')
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { title: 'T1', url: 'https://a.com', content: '内容A' },
          { title: 'T2', url: 'https://b.com', content: '内容B' },
        ],
      }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await webSearch.handler({ query: 'hello' })
    expect(result).toContain('T1')
    expect(result).toContain('https://a.com')
    expect(result).toContain('内容A')

    const [, init] = mockFetch.mock.calls[0]
    const body = JSON.parse(init.body)
    expect(body.api_key).toBe('fake-key')
    expect(body.query).toBe('hello')
  })

  it('搜索服务异常时抛错', async () => {
    vi.stubEnv('SEARCH_API_KEY', 'fake-key')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))
    await expect(webSearch.handler({ query: 'hello' })).rejects.toThrow('HTTP 500')
  })

  it('query 为空抛错', async () => {
    await expect(webSearch.handler({ query: '' })).rejects.toThrow('不能为空')
  })
})

import type { Tool } from '../agent/types'

const TAVILY_URL = 'https://api.tavily.com/search'

interface SearchResultItem {
  title?: string
  url?: string
  content?: string
}

function searchKey(): string {
  return process.env.SEARCH_API_KEY?.trim() ?? ''
}

export const webSearch: Tool = {
  name: 'web_search',
  description: '搜索互联网，返回相关网页的标题、链接与内容摘要',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      maxResults: { type: 'number', description: '返回条数（默认 5，最大 10）' },
    },
    required: ['query'],
  },
  handler: async (args) => {
    const query = String(args.query ?? '').trim()
    if (!query)
      throw new Error('query 不能为空')

    const key = searchKey()
    if (!key)
      return '搜索 API 未配置（缺少 SEARCH_API_KEY 环境变量），无法执行联网搜索。'

    const maxResults = Math.min(10, Math.max(1, Number(args.maxResults) || 5))
    const response = await fetch(TAVILY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, query, max_results: maxResults }),
    })
    if (!response.ok)
      throw new Error(`搜索服务返回 HTTP ${response.status}`)

    const data = await response.json() as { results?: SearchResultItem[] }
    const results = data.results ?? []
    if (results.length === 0)
      return '未找到相关搜索结果。'
    return results
      .map((item, i) => `${i + 1}. ${item.title ?? '(无标题)'}\n   ${item.url ?? ''}\n   ${item.content ?? ''}`)
      .join('\n')
  },
}

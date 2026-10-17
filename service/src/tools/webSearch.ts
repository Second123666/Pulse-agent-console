import type { Tool } from '../agent/types'

/** DeepSeek Search API（与 DeepSeek API 同域同 key，文档 https://api-docs.deepseek.com/guides/search） */
const DEEPSEEK_SEARCH_URL = 'https://api.deepseek.com/v1/tools/search'

interface DeepSeekSearchResult {
  title?: string
  url?: string
  snippet?: string
  summary?: string
  site_name?: string
  date?: string
}

/**
 * 搜索 key：优先 SEARCH_API_KEY（聊天与搜索分属不同服务商时单独配），
 * 缺省复用聊天服务商的 API_KEY —— 项目对话走 DeepSeek 时同一个 key 即可，零配置。
 */
function searchKey(): string {
  return process.env.SEARCH_API_KEY?.trim() || process.env.API_KEY?.trim() || ''
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
  // 每次调用都消耗搜索配额（按量计费），执行前需用户确认
  requiresApproval: true,
  approvalReason: '联网搜索会消耗 DeepSeek 搜索配额（按量计费）',
  handler: async (args) => {
    const query = String(args.query ?? '').trim()
    if (!query)
      throw new Error('query 不能为空')

    const key = searchKey()
    if (!key)
      return '搜索 API 未配置（缺少 SEARCH_API_KEY 或 API_KEY 环境变量），无法执行联网搜索。'

    const maxResults = Math.min(10, Math.max(1, Number(args.maxResults) || 5))
    const response = await fetch(DEEPSEEK_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      // count 官方范围 1..50；summary（600-800 字长摘要）默认返回，无需额外开关
      body: JSON.stringify({ query, count: maxResults }),
    })

    if (!response.ok) {
      // DeepSeek 错误信封为 { error: { message } }（如 api key 无效 / 余额不足），带出来便于排查
      let detail = ''
      try {
        detail = await response.text()
      }
      catch {
        // 读不出 body 不影响抛错
      }
      let message = detail.slice(0, 200)
      try {
        const parsed = JSON.parse(detail)
        message = parsed?.error?.message ?? parsed?.message ?? message
      }
      catch {
        // 非 JSON 就原样用截断后的文本
      }
      throw new Error(`搜索服务返回 HTTP ${response.status}${message ? `：${message}` : ''}`)
    }

    const payload = await response.json()
    const results: DeepSeekSearchResult[] = (payload as any)?.results ?? []
    if (results.length === 0)
      return '未找到相关搜索结果。'
    return results
      .map((item, i) => {
        // summary 是模型可读的长摘要，缺省回退 snippet
        const content = item.summary || item.snippet || ''
        const meta = [item.site_name, item.date?.slice(0, 10)].filter(Boolean).join(' · ')
        return `${i + 1}. ${item.title ?? '(无标题)'}\n   ${item.url ?? ''}${meta ? `\n   ${meta}` : ''}\n   ${content}`
      })
      .join('\n')
  },
}

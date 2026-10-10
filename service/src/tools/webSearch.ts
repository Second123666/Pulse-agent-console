import type { Tool } from '../agent/types'

/** 博查 Web Search API（国内直连，控制台 https://open.bochaai.com） */
const BOCHA_SEARCH_URL = 'https://api.bochaai.com/v1/web-search'

interface BochaPage {
  name?: string
  url?: string
  snippet?: string
  summary?: string
  siteName?: string
  datePublished?: string
}

function searchKey(): string {
  return process.env.SEARCH_API_KEY?.trim() ?? ''
}

/**
 * 取出结果数组。博查官方文档的响应为 `{ data: { webPages: { value } } }`，
 * 部分资料/网关版本直接给 `{ webPages: { value } }`，两种都兼容，避免因包裹层差异静默返回空结果。
 */
function extractPages(payload: any): BochaPage[] {
  return payload?.data?.webPages?.value ?? payload?.webPages?.value ?? []
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
  approvalReason: '联网搜索会消耗博查搜索配额（按量计费）',
  handler: async (args) => {
    const query = String(args.query ?? '').trim()
    if (!query)
      throw new Error('query 不能为空')

    const key = searchKey()
    if (!key)
      return '搜索 API 未配置（缺少 SEARCH_API_KEY 环境变量），无法执行联网搜索。'

    const maxResults = Math.min(10, Math.max(1, Number(args.maxResults) || 5))
    const response = await fetch(BOCHA_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({ query, count: maxResults, summary: true }),
    })

    if (!response.ok) {
      // 博查返回真实 HTTP 状态码，body 里带 message（如 Invalid API KEY / 余额不足），带出来便于排查
      let detail = ''
      try {
        detail = await response.text()
      }
      catch {
        // 读不出 body 不影响抛错
      }
      let message = detail.slice(0, 200)
      try {
        message = JSON.parse(detail)?.message ?? message
      }
      catch {
        // 非 JSON 就原样用截断后的文本
      }
      throw new Error(`搜索服务返回 HTTP ${response.status}${message ? `：${message}` : ''}`)
    }

    const payload = await response.json()
    const pages = extractPages(payload)
    if (pages.length === 0)
      return '未找到相关搜索结果。'
    return pages
      .map((item, i) => {
        // summary 是开启 summary:true 后的长摘要，缺省回退到 snippet
        const content = item.summary || item.snippet || ''
        const meta = [item.siteName, item.datePublished?.slice(0, 10)].filter(Boolean).join(' · ')
        return `${i + 1}. ${item.name ?? '(无标题)'}\n   ${item.url ?? ''}${meta ? `\n   ${meta}` : ''}\n   ${content}`
      })
      .join('\n')
  },
}

import type { Tool } from '../agent/types'
import { embedTexts } from '../rag/embed'
import { all, search, type VectorRecord } from '../rag/store'

/** 来源 = 块 id 的文件名部分（ingest 生成的 id 形如 <文件名>:<序号>） */
function sourceOf(record: VectorRecord): string {
  return record.id.split(':')[0]
}

/** 中英混合分词：英文按单词，中文按二元字符组 */
function tokenize(query: string): string[] {
  const english = (query.match(/[a-zA-Z0-9_]+/g) ?? []).map(word => word.toLowerCase())
  const chineseChars = query.replace(/[a-zA-Z0-9_\s]/g, '')
  const chinese: string[] = []
  for (let i = 0; i < chineseChars.length - 1; i++)
    chinese.push(chineseChars.slice(i, i + 2))
  return [...english, ...chinese].filter(Boolean)
}

export const ragSearch: Tool = {
  name: 'rag_search',
  description: '在项目知识库中检索与问题语义相关的内容，返回 top-3 块并附来源',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '要检索的问题或关键词' },
    },
    required: ['query'],
  },
  handler: async (args) => {
    const query = String(args.query ?? '').trim()
    if (!query)
      throw new Error('query 不能为空')

    let mode: 'embedding' | 'keyword' = 'embedding'
    let results: VectorRecord[] = []
    try {
      const [embedding] = await embedTexts([query])
      results = await search(embedding, 3)
    }
    catch {
      // embedding 不可用（缺 key / 接口失败）→ 降级为关键词匹配
      mode = 'keyword'
      const tokens = tokenize(query)
      results = (await all())
        .map(record => ({ record, score: tokens.reduce((sum, token) => sum + (record.text.includes(token) ? 1 : 0), 0) }))
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map(item => item.record)
    }

    if (results.length === 0)
      return mode === 'embedding' ? '知识库中未找到相关内容。' : '知识库中未找到匹配内容。'

    const modeNote = mode === 'keyword' ? '（已降级为关键词匹配）\n' : ''
    return `${modeNote}${results.map((record, i) => `${i + 1}. [来源：${sourceOf(record)}]\n${record.text.slice(0, 300)}`).join('\n\n')}`
  },
}

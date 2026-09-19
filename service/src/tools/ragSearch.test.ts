import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { clear, upsert } from '../rag/store'
import { ragSearch } from './ragSearch'

const { mockEmbedTexts } = vi.hoisted(() => ({ mockEmbedTexts: vi.fn() }))
vi.mock('../rag/embed', () => ({ embedTexts: mockEmbedTexts }))

const FILE = path.join(process.cwd(), 'data', 'vectors.json')

beforeEach(async () => {
  mockEmbedTexts.mockReset()
  await clear()
})

afterAll(async () => {
  await fs.rm(FILE, { force: true })
})

describe('rag_search', () => {
  it('embedding 可用时按向量检索 top-3 并附来源', async () => {
    mockEmbedTexts.mockResolvedValue([[1, 0, 0]])
    await upsert([
      { id: 'doc1.md:0', text: '苹果是水果', vector: [1, 0, 0] },
      { id: 'doc2.md:0', text: '香蕉是水果', vector: [0, 1, 0] },
      { id: 'doc3.md:0', text: '苹果汁好喝', vector: [0.9, 0.1, 0] },
    ])
    const result = await ragSearch.handler({ query: '苹果' })
    expect(result).toContain('[来源：doc1.md]')
    expect(result).toContain('[来源：doc3.md]')
    expect(result).not.toContain('降级')
    expect(mockEmbedTexts).toHaveBeenCalledTimes(1)
  })

  it('embedding 不可用时降级为关键词匹配并提示', async () => {
    mockEmbedTexts.mockRejectedValue(new Error('缺少 EMBEDDING_API_KEY'))
    await upsert([
      { id: 'a.md:0', text: '熔断机制防止死循环', vector: [1, 0] },
      { id: 'b.md:0', text: '工具系统包含计算器', vector: [0, 1] },
    ])
    const result = await ragSearch.handler({ query: '熔断 死循环' })
    expect(result).toContain('降级')
    expect(result).toContain('熔断机制防止死循环')
    expect(result).toContain('[来源：a.md]')
    expect(result).not.toContain('工具系统包含计算器')
  })

  it('知识库为空时返回未找到提示', async () => {
    mockEmbedTexts.mockResolvedValue([[1, 0, 0]])
    // 不写入任何记录（beforeEach 已 clear）
    const result = await ragSearch.handler({ query: '任何问题' })
    expect(result).toContain('未找到')
  })

  it('query 为空抛错', async () => {
    await expect(ragSearch.handler({ query: '' })).rejects.toThrow('不能为空')
  })
})

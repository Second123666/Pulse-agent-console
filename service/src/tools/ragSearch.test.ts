import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clear, upsert } from '../rag/store'
import { ragSearch } from './ragSearch'

// 向量库 12.5 起走 SQLite；getDb 惰性读 env，必须在第一次检索之前定死路径，
// 否则测试数据会写进真实的 data/agent.db
process.env.AGENT_DB_PATH = ':memory:'

const { mockEmbedTexts } = vi.hoisted(() => ({ mockEmbedTexts: vi.fn() }))
vi.mock('../rag/embed', () => ({ embedTexts: mockEmbedTexts }))

/** 已登录用户的工具上下文（12.1 起 handler 的第二个参数） */
const CTX = { userId: 1 }

beforeEach(async () => {
  mockEmbedTexts.mockReset()
  await clear()
})

describe('rag_search', () => {
  it('embedding 可用时按向量检索 top-3 并附来源', async () => {
    mockEmbedTexts.mockResolvedValue([[1, 0, 0]])
    await upsert([
      { id: 'doc1.md:0', text: '苹果是水果', vector: [1, 0, 0], userId: 1, docId: 'doc1.md' },
      { id: 'doc2.md:0', text: '香蕉是水果', vector: [0, 1, 0], userId: 1, docId: 'doc2.md' },
      { id: 'doc3.md:0', text: '苹果汁好喝', vector: [0.9, 0.1, 0], userId: 1, docId: 'doc3.md' },
    ])
    const result = await ragSearch.handler({ query: '苹果' }, CTX)
    expect(result).toContain('[来源：doc1.md]')
    expect(result).toContain('[来源：doc3.md]')
    expect(result).not.toContain('降级')
    expect(mockEmbedTexts).toHaveBeenCalledTimes(1)
  })

  it('embedding 不可用时降级为关键词匹配并提示', async () => {
    mockEmbedTexts.mockRejectedValue(new Error('缺少 EMBEDDING_API_KEY'))
    await upsert([
      { id: 'a.md:0', text: '熔断机制防止死循环', vector: [1, 0], userId: 1, docId: 'a.md' },
      { id: 'b.md:0', text: '工具系统包含计算器', vector: [0, 1], userId: 1, docId: 'b.md' },
    ])
    const result = await ragSearch.handler({ query: '熔断 死循环' }, CTX)
    expect(result).toContain('降级')
    expect(result).toContain('熔断机制防止死循环')
    expect(result).toContain('[来源：a.md]')
    expect(result).not.toContain('工具系统包含计算器')
  })

  it('知识库为空时返回未找到提示', async () => {
    mockEmbedTexts.mockResolvedValue([[1, 0, 0]])
    // 不写入任何记录（beforeEach 已 clear）
    const result = await ragSearch.handler({ query: '任何问题' }, CTX)
    expect(result).toContain('未找到')
  })

  it('query 为空抛错', async () => {
    await expect(ragSearch.handler({ query: '' }, CTX)).rejects.toThrow('不能为空')
  })

  describe('多租户隔离（12.1）', () => {
    it('未登录（无 userId）时拒绝服务，且不泄露任何内容、也不调用 embedding', async () => {
      mockEmbedTexts.mockResolvedValue([[1, 0, 0]])
      await upsert([{ id: 'a.md:0', text: '机密内容', vector: [1, 0, 0], userId: 1, docId: 'a.md' }])

      const result = await ragSearch.handler({ query: '机密' })
      expect(result).toContain('未登录')
      expect(result).not.toContain('机密内容')
      expect(mockEmbedTexts).not.toHaveBeenCalled()
    })

    it('userId 非法（0 / 负数 / 小数）同样拒绝服务', async () => {
      for (const userId of [0, -1, 1.5]) {
        const result = await ragSearch.handler({ query: '任何' }, { userId })
        expect(result).toContain('未登录')
      }
    })

    it('向量检索路径不返回别的用户的块', async () => {
      mockEmbedTexts.mockResolvedValue([[1, 0, 0]])
      await upsert([
        { id: 'mine.md:0', text: '我的苹果', vector: [1, 0, 0], userId: 1, docId: 'mine.md' },
        { id: 'other.md:0', text: '别人的苹果', vector: [1, 0, 0], userId: 2, docId: 'other.md' },
      ])
      const result = await ragSearch.handler({ query: '苹果' }, CTX)
      expect(result).toContain('我的苹果')
      expect(result).not.toContain('别人的苹果')
      expect(result).not.toContain('other.md')
    })

    it('关键词降级路径同样不返回别的用户的块', async () => {
      mockEmbedTexts.mockRejectedValue(new Error('无 key'))
      await upsert([
        { id: 'mine.md:0', text: '熔断机制说明', vector: [1, 0], userId: 1, docId: 'mine.md' },
        { id: 'other.md:0', text: '熔断机制说明', vector: [1, 0], userId: 2, docId: 'other.md' },
      ])
      const result = await ragSearch.handler({ query: '熔断' }, CTX)
      expect(result).toContain('mine.md')
      expect(result).not.toContain('other.md')
    })
  })
})

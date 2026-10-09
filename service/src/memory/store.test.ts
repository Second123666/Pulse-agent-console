import { beforeEach, describe, expect, it } from 'vitest'

// 环境必须在**动态 import 之前**设置（getDb 惰性读 env，首次调用即固定路径）
process.env.AGENT_DB_PATH = ':memory:'

const { deleteMemory, getMemory, listMemories, searchMemories, upsertMemory } = await import('./store')
const { getDb } = await import('../store/db')

beforeEach(() => {
  getDb().exec('DELETE FROM memory')
})

/** 构造一个单位向量：第 index 维为 1，其余为 0 */
function axisVector(dim: number, index: number): number[] {
  const vector = new Array(dim).fill(0)
  vector[index] = 1
  return vector
}

describe('upsertMemory / getMemory', () => {
  it('写入后可读回，embedding 向量逐位还原', () => {
    const embedding = [0.125, -0.5, 0.75, 1]
    upsertMemory({ userId: 1, conversationId: 10, summary: '用户在做 Agent 工作台', embedding, messageCount: 6 })

    const row = getMemory(1, 10)
    expect(row).not.toBeNull()
    expect(row!.summary).toBe('用户在做 Agent 工作台')
    expect(row!.messageCount).toBe(6)
    expect(row!.conversationId).toBe(10)
    expect(row!.createdAt).toBeGreaterThan(0)

    const stored = searchMemories(1, embedding, 1)
    expect(stored).toHaveLength(1)
    expect(stored[0].score).toBeCloseTo(1, 5)
  })

  it('同一 (user, conversation) 重复写入是更新而非新增', () => {
    upsertMemory({ userId: 1, conversationId: 10, summary: '第一版', embedding: null, messageCount: 6 })
    upsertMemory({ userId: 1, conversationId: 10, summary: '第二版', embedding: null, messageCount: 12 })

    expect(listMemories(1)).toHaveLength(1)
    expect(getMemory(1, 10)!.summary).toBe('第二版')
    expect(getMemory(1, 10)!.messageCount).toBe(12)
  })

  it('不同用户各自的同名 conversationId 互不干扰', () => {
    upsertMemory({ userId: 1, conversationId: 10, summary: 'alice 的', embedding: null, messageCount: 6 })
    upsertMemory({ userId: 2, conversationId: 10, summary: 'bob 的', embedding: null, messageCount: 6 })

    expect(getMemory(1, 10)!.summary).toBe('alice 的')
    expect(getMemory(2, 10)!.summary).toBe('bob 的')
    expect(listMemories(1)).toHaveLength(1)
  })

  it('未写入过时返回 null', () => {
    expect(getMemory(1, 999)).toBeNull()
  })
})

describe('listMemories', () => {
  it('按用户过滤，且遵守 limit', () => {
    upsertMemory({ userId: 1, conversationId: 1, summary: 'a', embedding: null, messageCount: 6 })
    upsertMemory({ userId: 1, conversationId: 2, summary: 'b', embedding: null, messageCount: 6 })
    upsertMemory({ userId: 1, conversationId: 3, summary: 'c', embedding: null, messageCount: 6 })
    upsertMemory({ userId: 2, conversationId: 4, summary: '别人的', embedding: null, messageCount: 6 })

    expect(listMemories(1)).toHaveLength(3)
    expect(listMemories(1, 2)).toHaveLength(2)
    expect(listMemories(2).map(item => item.summary)).toEqual(['别人的'])
  })
})

describe('searchMemories', () => {
  it('按余弦相似度排序并取 top-k', () => {
    upsertMemory({ userId: 1, conversationId: 1, summary: '最相关', embedding: axisVector(4, 0), messageCount: 6 })
    upsertMemory({ userId: 1, conversationId: 2, summary: '次相关', embedding: [0.6, 0.8, 0, 0], messageCount: 6 })
    upsertMemory({ userId: 1, conversationId: 3, summary: '不相关', embedding: axisVector(4, 3), messageCount: 6 })

    const results = searchMemories(1, axisVector(4, 0), 2)
    expect(results.map(item => item.summary)).toEqual(['最相关', '次相关'])
    expect(results[0].score).toBeCloseTo(1, 5)
    expect(results[1].score).toBeCloseTo(0.6, 5)
  })

  it('跳过没有向量的记忆，不参与相似度检索', () => {
    upsertMemory({ userId: 1, conversationId: 1, summary: '无向量', embedding: null, messageCount: 6 })
    upsertMemory({ userId: 1, conversationId: 2, summary: '有向量', embedding: axisVector(4, 0), messageCount: 6 })

    const results = searchMemories(1, axisVector(4, 0), 5)
    expect(results.map(item => item.summary)).toEqual(['有向量'])
  })

  it('只在自己的记忆里检索', () => {
    upsertMemory({ userId: 2, conversationId: 1, summary: 'bob 的记忆', embedding: axisVector(4, 0), messageCount: 6 })

    expect(searchMemories(1, axisVector(4, 0), 5)).toEqual([])
  })

  it('维度不一致的向量不会误报高分', () => {
    upsertMemory({ userId: 1, conversationId: 1, summary: '维度不同', embedding: [1, 0], messageCount: 6 })

    const results = searchMemories(1, axisVector(4, 0), 5)
    expect(results[0].score).toBe(0)
  })
})

describe('deleteMemory', () => {
  it('删除自己的记忆返回 true，重复删除返回 false', () => {
    upsertMemory({ userId: 1, conversationId: 10, summary: 'x', embedding: null, messageCount: 6 })

    expect(deleteMemory(1, 10)).toBe(true)
    expect(deleteMemory(1, 10)).toBe(false)
    expect(getMemory(1, 10)).toBeNull()
  })

  it('删不掉别人的记忆', () => {
    upsertMemory({ userId: 2, conversationId: 10, summary: 'x', embedding: null, messageCount: 6 })

    expect(deleteMemory(1, 10)).toBe(false)
    expect(getMemory(2, 10)).not.toBeNull()
  })
})

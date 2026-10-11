import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { type VectorRecord, all, clear, cosineSimilarity, search, upsert } from './store'

const FILE = path.join(process.cwd(), 'data', 'vectors.json')

/** 造一条记录：只关心 id / 向量 / 归属，其余用默认值 */
function rec(id: string, vector: number[], userId: number, text = id): VectorRecord {
  return { id, text, vector, userId, docId: 'doc' }
}

beforeEach(async () => {
  await clear()
})

afterAll(async () => {
  await fs.rm(FILE, { force: true })
})

describe('vector store', () => {
  it('upsert 后 search 按余弦相似度返回 top-k', async () => {
    await upsert([
      rec('a', [1, 0, 0], 1, '苹果'),
      rec('b', [0, 1, 0], 1, '香蕉'),
      rec('c', [0.9, 0.1, 0], 1, '苹果汁'),
    ])
    const result = await search([1, 0, 0], 1, 2)
    expect(result.map(r => r.id)).toEqual(['a', 'c'])
  })

  it('持久化到 service/data/vectors.json，且带上归属字段', async () => {
    await upsert([rec('x', [1, 1], 7, '测试')])
    const data = JSON.parse(await fs.readFile(FILE, 'utf-8'))
    expect(data[0].id).toBe('x')
    expect(data[0].vector).toEqual([1, 1])
    expect(data[0].userId).toBe(7)
    expect(data[0].docId).toBe('doc')
  })

  it('cosineSimilarity 边界', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0)
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(-1)
    expect(cosineSimilarity([], [])).toBe(0)
    expect(cosineSimilarity([1, 2], [1])).toBe(0)
  })
})

describe('多租户隔离（12.1）', () => {
  beforeEach(async () => {
    await upsert([
      rec('a1', [1, 0, 0], 1, '甲的苹果'),
      rec('a2', [0.9, 0.1, 0], 1, '甲的苹果汁'),
      rec('b1', [1, 0, 0], 2, '乙的苹果'),
      rec('b2', [0, 1, 0], 2, '乙的香蕉'),
    ])
  })

  it('检索结果只含自己的块', async () => {
    const forA = await search([1, 0, 0], 1, 10)
    expect(forA.map(r => r.id).sort()).toEqual(['a1', 'a2'])
    expect(forA.every(r => r.userId === 1)).toBe(true)

    const forB = await search([1, 0, 0], 2, 10)
    expect(forB.map(r => r.id).sort()).toEqual(['b1', 'b2'])
    expect(forB.every(r => r.userId === 2)).toBe(true)
  })

  it('同一 query 在不同 userId 下 top-k 不同', async () => {
    const forA = await search([1, 0, 0], 1, 1)
    const forB = await search([1, 0, 0], 2, 1)
    expect(forA[0].id).toBe('a1')
    expect(forB[0].id).toBe('b1')
  })

  it('关键词降级用的 all() 也只返回自己的块', async () => {
    expect((await all(1)).map(r => r.id).sort()).toEqual(['a1', 'a2'])
    expect((await all(2)).map(r => r.id).sort()).toEqual(['b1', 'b2'])
  })

  it('不存在的 userId 查不到任何东西', async () => {
    expect(await search([1, 0, 0], 999, 10)).toEqual([])
    expect(await all(999)).toEqual([])
  })

  it('缺 userId 的遗留记录对所有人不可见（fail-closed）', async () => {
    // 迁移前的 vectors.json 里没有 userId 字段。用类型断言绕过编译期检查，
    // 模拟「这类记录仍留在库里」的情形
    await upsert([{ id: 'legacy', text: '遗留', vector: [1, 0, 0] } as unknown as VectorRecord])
    expect((await search([1, 0, 0], 1, 10)).map(r => r.id)).not.toContain('legacy')
    expect((await all(1)).map(r => r.id)).not.toContain('legacy')
  })
})

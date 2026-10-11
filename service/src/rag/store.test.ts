import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { VectorRecord } from './store'

// 环境必须在**动态 import 之前**设置（getDb 惰性读 env，首次调用即固定路径）。
// 不设的话 upsert 会直接写进真实的 data/agent.db
process.env.AGENT_DB_PATH = ':memory:'

const { all, clear, cosineSimilarity, mergeLegacyFile, remove, search, upsert } = await import('./store')
const { getDb } = await import('../store/db')
const { fromBlob } = await import('../store/vectorBlob')

/** 临时目录：旧库迁移的测试要用真实文件，但不能去抢 data/vectors.json 那个共享路径 */
const TMP_DIR = path.join(os.tmpdir(), 'rag-store-legacy-test')

/** 造一条记录：只关心 id / 向量 / 归属，其余用默认值 */
function rec(id: string, vector: number[], userId: number, text = id): VectorRecord {
  return { id, text, vector, userId, docId: 'doc' }
}

beforeEach(async () => {
  await clear()
})

afterAll(async () => {
  await fs.rm(TMP_DIR, { recursive: true, force: true })
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

  it('12.5：记录落在 SQLite 的 vectors 表里，向量是 Float32 BLOB', async () => {
    await upsert([rec('x', [1, 1], 7, '测试')])

    const row = getDb().prepare('SELECT * FROM vectors WHERE id = ?').get('x') as any
    expect(row.user_id).toBe(7)
    expect(row.doc_id).toBe('doc')
    expect(row.text).toBe('测试')
    expect(row.vector).toBeInstanceOf(Uint8Array)
    expect(fromBlob(row.vector)).toEqual([1, 1])

    // 同一条记录经 API 读回来也是完整的
    const [record] = await all(7)
    expect(record).toMatchObject({ id: 'x', text: '测试', vector: [1, 1], userId: 7, docId: 'doc' })
  })

  it('12.5：Float32 往返误差 < 1e-6，且不改变 top-k 排序', async () => {
    const vectors = [[0.1, 0.2, 0.3], [0.3, 0.2, 0.1], [0.15, 0.25, 0.35]]
    await upsert(vectors.map((vector, i) => ({ id: `v${i}`, text: `v${i}`, vector, userId: 3, docId: 'd' })))

    for (const row of await all(3)) {
      const origin = vectors[Number(row.id.slice(1))]
      row.vector.forEach((value, dim) => {
        expect(Math.abs(value - origin[dim])).toBeLessThan(1e-6)
      })
    }

    // 0.1/0.2/0.3 与自己最近；Float32 精度不足以把它挤到第二名
    const ranked = await search([0.1, 0.2, 0.3], 3, 3)
    expect(ranked.map(r => r.id)).toEqual(['v0', 'v2', 'v1'])
  })

  it('同 id 再次 upsert 是覆盖而不是新增', async () => {
    await upsert([rec('a', [1, 0, 0], 1, '旧')])
    await upsert([rec('a', [0, 1, 0], 1, '新')])
    const rows = getDb().prepare('SELECT COUNT(*) AS n FROM vectors').get() as any
    expect(Number(rows.n)).toBe(1)
    expect((await all(1))[0].text).toBe('新')
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
    // 模拟「这类记录仍留在库里」的情形。落库时 user_id 是 NULL，
    // 而 SQL 里 `user_id = ?` 对 NULL 恒不成立 —— 这就是 fail-closed 的实现方式
    await upsert([{ id: 'legacy', text: '遗留', vector: [1, 0, 0] } as unknown as VectorRecord])
    expect((await search([1, 0, 0], 1, 10)).map(r => r.id)).not.toContain('legacy')
    expect((await all(1)).map(r => r.id)).not.toContain('legacy')

    const row = getDb().prepare('SELECT user_id FROM vectors WHERE id = ?').get('legacy') as any
    expect(row.user_id).toBeNull()
  })

  it('按条件删除不会波及别人的块', async () => {
    const removed = await remove(record => record.userId === 1 && record.docId === 'doc')
    expect(removed).toBe(2)
    expect((await all(1))).toEqual([])
    expect((await all(2)).map(r => r.id).sort()).toEqual(['b1', 'b2'])
  })
})

describe('旧 vectors.json 迁移（12.5）', () => {
  it('并进 SQLite 后 top-k 与迁移前一致，且改名防止二次导入', async () => {
    const legacyRows = [
      { id: 'old-a', text: 'A', vector: [1, 0, 0], userId: 5, docId: 'old.md' },
      { id: 'old-b', text: 'B', vector: [0.8, 0.6, 0], userId: 5, docId: 'old.md' },
      { id: 'old-c', text: 'C', vector: [0, 1, 0], userId: 5, docId: 'old.md' },
      { id: 'old-d', text: 'D', vector: [0.5, 0, 0.5], userId: 5, docId: 'old.md' },
      { id: 'other', text: '别人的块', vector: [1, 0, 0], userId: 6, docId: 'other.md' },
      { id: 'orphan', text: '没归属的块', vector: [1, 0, 0], docId: 'orphan' },
    ]

    await fs.mkdir(TMP_DIR, { recursive: true })
    const legacy = path.join(TMP_DIR, 'vectors.json')
    await fs.writeFile(legacy, JSON.stringify(legacyRows))

    expect(mergeLegacyFile(legacy)).toBe(legacyRows.length)

    // 迁移前的实现就是「按 userId 过滤 → 余弦 → 降序取 top-k」，照它复算一遍当基准：
    // SQLite 版必须给出同一顺序，否则「换个存储而已」就是在骗人
    const query = [1, 0, 0]
    const reference = legacyRows
      .filter(row => row.userId === 5)
      .map(row => ({ id: row.id, score: cosineSimilarity(query, row.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(item => item.id)
    expect(reference).toEqual(['old-a', 'old-b', 'old-d'])

    const migrated = await search(query, 5, 3)
    expect(migrated.map(r => r.id)).toEqual(reference)
    // 别人的同向量块、缺归属的块都不进候选集
    expect(migrated.map(r => r.id)).not.toContain('other')
    expect((await all(999)).map(r => r.id)).not.toContain('orphan')

    // 改名 = 备份 + 不会二次导入
    expect(existsSync(legacy)).toBe(false)
    expect(existsSync(`${legacy}.imported`)).toBe(true)
  })

  it('文件不存在返回 0 且不动文件系统', () => {
    expect(mergeLegacyFile(path.join(TMP_DIR, 'nope.json'))).toBe(0)
  })

  it('格式不认识时抛错并把原文件留在原处', async () => {
    await fs.mkdir(TMP_DIR, { recursive: true })
    const bogus = path.join(TMP_DIR, 'bogus.json')
    await fs.writeFile(bogus, JSON.stringify({ not: 'an array' }))

    expect(() => mergeLegacyFile(bogus)).toThrow()
    expect(existsSync(bogus)).toBe(true)
  })
})

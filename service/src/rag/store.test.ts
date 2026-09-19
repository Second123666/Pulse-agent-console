import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { clear, cosineSimilarity, search, upsert } from './store'

const FILE = path.join(process.cwd(), 'data', 'vectors.json')

beforeEach(async () => {
  await clear()
})

afterAll(async () => {
  await fs.rm(FILE, { force: true })
})

describe('vector store', () => {
  it('upsert 后 search 按余弦相似度返回 top-k', async () => {
    await upsert([
      { id: 'a', text: '苹果', vector: [1, 0, 0] },
      { id: 'b', text: '香蕉', vector: [0, 1, 0] },
      { id: 'c', text: '苹果汁', vector: [0.9, 0.1, 0] },
    ])
    const result = await search([1, 0, 0], 2)
    expect(result.map(r => r.id)).toEqual(['a', 'c'])
  })

  it('持久化到 service/data/vectors.json', async () => {
    await upsert([{ id: 'x', text: '测试', vector: [1, 1] }])
    const data = JSON.parse(await fs.readFile(FILE, 'utf-8'))
    expect(data[0].id).toBe('x')
    expect(data[0].vector).toEqual([1, 1])
  })

  it('cosineSimilarity 边界', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0)
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(-1)
    expect(cosineSimilarity([], [])).toBe(0)
    expect(cosineSimilarity([1, 2], [1])).toBe(0)
  })
})

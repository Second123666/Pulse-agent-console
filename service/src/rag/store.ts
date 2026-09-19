import { promises as fs } from 'node:fs'
import path from 'node:path'

// 向量库：内存 + 持久化到 service/data/vectors.json（该目录已在 .gitignore）
const DATA_DIR = path.resolve(process.cwd(), 'data')
const VECTORS_FILE = path.join(DATA_DIR, 'vectors.json')

export interface VectorRecord {
  id: string
  text: string
  vector: number[]
}

let records: VectorRecord[] = []
let loaded = false

async function ensureLoaded(): Promise<void> {
  if (loaded)
    return
  try {
    const raw = await fs.readFile(VECTORS_FILE, 'utf-8')
    const data = JSON.parse(raw)
    records = Array.isArray(data) ? data : []
  }
  catch {
    records = []
  }
  loaded = true
}

async function persist(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.writeFile(VECTORS_FILE, JSON.stringify(records), 'utf-8')
}

/** 余弦相似度：-1 ~ 1；维度不一致或零向量返回 0 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length)
    return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0)
    return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/** 按 id 覆盖式写入向量并持久化 */
export async function upsert(items: VectorRecord[]): Promise<void> {
  await ensureLoaded()
  const byId = new Map(records.map(record => [record.id, record]))
  for (const item of items)
    byId.set(item.id, item)
  records = [...byId.values()]
  await persist()
}

/** 按余弦相似度返回 top-k */
export async function search(queryEmbedding: number[], k = 3): Promise<VectorRecord[]> {
  await ensureLoaded()
  return records
    .map(record => ({ record, score: cosineSimilarity(queryEmbedding, record.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(x => x.record)
}

/** 清空向量库（测试用） */
export async function clear(): Promise<void> {
  records = []
  loaded = true
  await persist()
}

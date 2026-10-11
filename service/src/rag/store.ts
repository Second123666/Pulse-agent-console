import { promises as fs } from 'node:fs'
import path from 'node:path'

// 向量库：内存 + 持久化到 service/data/vectors.json（该目录已在 .gitignore）
const DATA_DIR = path.resolve(process.cwd(), 'data')
const VECTORS_FILE = path.join(DATA_DIR, 'vectors.json')

export interface VectorRecord {
  id: string
  text: string
  vector: number[]
  /**
   * 归属用户。**必填**。
   *
   * 向量库是多租户的 —— 7.1 引入多用户鉴权之后，没有归属的块等于「谁都能检索到」，
   * 就是一条数据泄露通道。设成必填而非可选是刻意的：任何新增的写入点都会被编译器
   * 逼着交代归属，不会因为「忘了填」而静默泄露。
   */
  userId: number
  /** 文档级分组：同一次上传的块共享同一个 docId，供按文档删除 / 重建用 */
  docId: string
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

/**
 * 按余弦相似度返回**该用户**的 top-k。
 *
 * `userId` 是必填参数，且过滤发生在**排序之前** —— 别人的块根本不进入候选集。
 * 不做「先全量排序再按 userId 过滤」：那样结果虽然一样，但一旦哪次改动漏掉过滤就是静默泄露，
 * 而过滤前置时漏掉参数根本编译不过。
 *
 * 迁移前的遗留记录没有 `userId` 字段，`undefined === userId` 恒为 false，
 * 因此对**所有人**都不可见 —— fail-closed，宁可查不到也不误给。
 */
export async function search(queryEmbedding: number[], userId: number, k = 3): Promise<VectorRecord[]> {
  await ensureLoaded()
  return records
    .filter(record => record.userId === userId)
    .map(record => ({ record, score: cosineSimilarity(queryEmbedding, record.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(x => x.record)
}

/** 返回**该用户**的全部记录（关键词降级检索用） */
export async function all(userId: number): Promise<VectorRecord[]> {
  await ensureLoaded()
  return records.filter(record => record.userId === userId)
}

/**
 * 按条件删除记录，返回删除条数（按文档删除用，见 knowledge/store.ts）。
 *
 * 谓词由调用方给出 —— 调用方必须把 `userId` 一并写进条件里，否则会删到别人的块。
 */
export async function remove(predicate: (record: VectorRecord) => boolean): Promise<number> {
  await ensureLoaded()
  const before = records.length
  records = records.filter(record => !predicate(record))
  const removed = before - records.length
  if (removed > 0)
    await persist()
  return removed
}

/** 清空向量库（测试用） */
export async function clear(): Promise<void> {
  records = []
  loaded = true
  await persist()
}

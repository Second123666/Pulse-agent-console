import { existsSync, readFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import { getDb } from '../store/db'
import { fromBlob, toBlob } from '../store/vectorBlob'

/**
 * 向量库：SQLite（`agent.db` 的 `vectors` 表，见 store/db.ts 的建表语句）。
 *
 * 12.5 之前是「内存数组 + 整文件覆写 `data/vectors.json`」—— 每次 upsert 全量重写、
 * 所有租户的块都摊在同一个数组里。迁到 SQLite 之后：按 `user_id` 走索引、只解码
 * 自己的块，删除/重建是事务性的，写入也不再整文件重写。
 *
 * **本文件的导出签名与迁移前完全一致**（全部 async，参数不变），调用方一行都不用改。
 */
const DATA_DIR = path.resolve(process.cwd(), 'data')
/** 迁移前的落盘文件；并入 SQLite 后会改名成 `vectors.json.imported`（见 mergeLegacyFile） */
const LEGACY_FILE = path.join(DATA_DIR, 'vectors.json')

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

/** 事务包装：一批写入要么全进要么全不进（upsert / 删除 / 旧库迁移共用） */
function inTransaction(fn: () => void): void {
  const db = getDb()
  db.exec('BEGIN')
  try {
    fn()
    db.exec('COMMIT')
  }
  catch (error) {
    try {
      db.exec('ROLLBACK')
    }
    catch {
      // 回滚本身失败说明事务已经不在了（连接被外部关掉之类），把原始错误抛出去更要紧
    }
    throw error
  }
}

/**
 * 缺归属的 userId 写成 NULL。
 * 不写成 0 —— 0 不是任何真实用户，却会被 `user_id = 0` 的查询捞到；
 * NULL 则被 SQL 的三值逻辑天然排除在所有等值查询之外，这才是 fail-closed。
 */
function toUserId(userId: number): number | null {
  return (typeof userId === 'number' && Number.isFinite(userId)) ? userId : null
}

function toRecord(raw: any): VectorRecord {
  // user_id 为 NULL 时读回 undefined：`remove` 的 JS 谓词同样匹配不到它，与查询侧语义一致
  const hasOwner = raw.user_id !== null && raw.user_id !== undefined
  return {
    id: String(raw.id),
    text: String(raw.text ?? ''),
    // 建表时 vector 是 NOT NULL，正常读不到空；兜底成空向量（余弦返回 0，排在末尾）而不是抛错
    vector: fromBlob(raw.vector) ?? [],
    userId: hasOwner ? Number(raw.user_id) : undefined as unknown as number,
    docId: String(raw.doc_id ?? ''),
  }
}

function selectByUser(userId: number): VectorRecord[] {
  const rows = getDb()
    .prepare('SELECT * FROM vectors WHERE user_id = ?')
    .all(userId) as any[]
  return rows.map(toRecord)
}

let migrated = false

/**
 * 把迁移前的 `vectors.json` 并进 SQLite，成功后把旧文件改名成 `*.imported`。
 *
 * **为什么要做**：旧格式里除了 CLI 灌的文档，还有 12.2 起**只能在向量库里存在**的上传文档
 * （正文不落盘，元信息在 `knowledge_docs`）。不并过来的话，那些文档会变成
 * 「列表里有、检索不到」的僵尸，而且没有任何办法重建。
 *
 * **为什么改名**：不改名的话，下次启动会再并一次 —— 用户已经删掉的块会诈尸回来。
 * 改名后旧文件留作备份，导入也天然只发生一次。
 *
 * 路径作为参数是为了让测试拿临时文件来验，不去抢 `data/vectors.json` 那个真实路径
 * （多个测试文件并行跑，谁动了共享路径都会互相污染）。
 * 文件不存在或不是数组时原样返回、**不改名** —— 读不懂的东西不能一删了之。
 *
 * @returns 并入的条数；JSON 解析失败会抛出，由调用方决定怎么兜
 */
export function mergeLegacyFile(file: string): number {
  if (!existsSync(file))
    return 0
  const data = JSON.parse(readFileSync(file, 'utf-8'))
  if (!Array.isArray(data))
    throw new Error(`${file} 不是旧版向量库格式（期望 JSON 数组）`)
  if (data.length > 0) {
    const stmt = getDb().prepare(
      'INSERT OR REPLACE INTO vectors (id, text, vector, user_id, doc_id) VALUES (?, ?, ?, ?, ?)',
    )
    inTransaction(() => {
      for (const row of data) {
        stmt.run(
          String(row.id ?? ''),
          String(row.text ?? ''),
          toBlob(Array.isArray(row.vector) ? row.vector : []),
          toUserId(row.userId),
          String(row.docId ?? ''),
        )
      }
    })
    // 只在真的并进了东西时才改名：空文件改名没意义，还会让「文件去哪了」变得难查
    renameSync(file, `${file}.imported`)
  }
  return data.length
}

/**
 * 启动后第一次访问向量库时，把旧的 `data/vectors.json` 并进来（每个进程只跑一次）。
 *
 * **`:memory:` 库直接跳过**：不落盘的库并进来的数据下个进程就没了，纯属把用户的备份
 * 消费掉 —— 测试恰好都跑在 `:memory:` 上，所以这条同时是「测试不许动真实旧库」的护栏。
 *
 * **失败只告警不抛出**：这是迁移路径，不能因为读不懂旧文件就把整个向量库打挂 ——
 * 新写入照常工作，原文件也留在原处等人工处理。
 */
function ensureMigrated(): void {
  if (migrated)
    return
  migrated = true
  if ((process.env.AGENT_DB_PATH ?? '').trim() === ':memory:')
    return
  try {
    const merged = mergeLegacyFile(LEGACY_FILE)
    if (merged > 0) {
      // 迁移是运维关心的一次性事件，值得留一行痕迹；失败走下面的 console.warn（warn 本身是允许的）
      // eslint-disable-next-line no-console
      console.log(`[rag] 已将 ${merged} 条旧向量从 vectors.json 并入 SQLite`)
    }
  }
  catch (error: any) {
    console.warn(`[rag] 旧向量库迁移失败（新写入不受影响，原文件保留在原处）：${error?.message ?? error}`)
  }
}

/** 按 id 覆盖式写入向量（同批同 id 时后者生效），整批一个事务 */
export async function upsert(items: VectorRecord[]): Promise<void> {
  ensureMigrated()
  if (items.length === 0)
    return

  const stmt = getDb().prepare(`
    INSERT INTO vectors (id, text, vector, user_id, doc_id) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      text    = excluded.text,
      vector  = excluded.vector,
      user_id = excluded.user_id,
      doc_id  = excluded.doc_id
  `)
  inTransaction(() => {
    for (const item of items)
      stmt.run(item.id, item.text, toBlob(item.vector ?? []), toUserId(item.userId), item.docId ?? '')
  })
}

/**
 * 按余弦相似度返回**该用户**的 top-k。
 *
 * `userId` 是必填参数，且过滤发生在 SQL 里、**在排序之前** —— 别人的块根本不进候选集。
 * 不做「先全量排序再按 userId 过滤」：那样结果虽然一样，但一旦哪次改动漏掉过滤就是静默泄露，
 * 而过滤前置时漏掉参数根本编译不过。
 *
 * 缺 `userId` 的遗留/异常记录 `user_id` 是 NULL，`NULL = ?` 恒不成立，
 * 因此对**所有人**都不可见 —— fail-closed，宁可查不到也不误给。
 */
export async function search(queryEmbedding: number[], userId: number, k = 3): Promise<VectorRecord[]> {
  ensureMigrated()
  return selectByUser(userId)
    .map(record => ({ record, score: cosineSimilarity(queryEmbedding, record.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(x => x.record)
}

/** 返回**该用户**的全部记录（关键词降级检索用） */
export async function all(userId: number): Promise<VectorRecord[]> {
  ensureMigrated()
  return selectByUser(userId)
}

/**
 * 按条件删除记录，返回删除条数（按文档删除用，见 knowledge/store.ts）。
 *
 * 谓词由调用方给出 —— 调用方必须把 `userId` 一并写进条件里，否则会删到别人的块。
 * 谓词是 JS 函数，SQL 里代不进去，所以先取全表再筛；删除本身按 id 走事务。
 */
export async function remove(predicate: (record: VectorRecord) => boolean): Promise<number> {
  ensureMigrated()
  const db = getDb()
  const ids = (db.prepare('SELECT * FROM vectors').all() as any[])
    .map(toRecord)
    .filter(predicate)
    .map(record => record.id)
  if (ids.length === 0)
    return 0

  const stmt = db.prepare('DELETE FROM vectors WHERE id = ?')
  inTransaction(() => {
    for (const id of ids)
      stmt.run(id)
  })
  return ids.length
}

/** 清空向量库（测试用） */
export async function clear(): Promise<void> {
  ensureMigrated()
  getDb().exec('DELETE FROM vectors')
}

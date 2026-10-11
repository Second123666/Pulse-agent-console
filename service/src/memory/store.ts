import { cosineSimilarity } from '../rag/store'
import { getDb } from '../store/db'
import { fromBlob, toBlob } from '../store/vectorBlob'

/**
 * 长期记忆的持久化层。
 *
 * **不新建第二个向量库**：向量以 Float32 BLOB 存在 SQLite 里，检索复用
 * `rag/store.ts` 的 `cosineSimilarity`（同一套余弦实现，避免两处算法漂移）。
 * 记忆条数按用户量级很小（每个会话最多一条），全量取出做暴力检索完全够用。
 *
 * **多租户隔离**：所有导出函数第一个参数都是 `userId`，每条 SQL 都带
 * `user_id = ?` 过滤。
 */

export interface MemoryRow {
  id: number
  userId: number
  conversationId: number
  summary: string
  /** 生成该摘要时的会话消息条数（用于判断「距上次摘要新增了多少」，避免重复摘要） */
  messageCount: number
  createdAt: number
}

export interface ScoredMemory extends MemoryRow {
  score: number
}

/** number[] → Float32 BLOB / BLOB → number[] 统一放在 store/vectorBlob.ts，与向量库共用一份 */

function toRow(raw: any): MemoryRow {
  return {
    id: Number(raw.id),
    userId: Number(raw.user_id),
    conversationId: Number(raw.conversation_id),
    summary: String(raw.summary ?? ''),
    messageCount: Number(raw.message_count ?? 0),
    createdAt: Number(raw.created_at),
  }
}

/**
 * 写入/刷新某个会话的记忆（每个会话至多一条，靠 `UNIQUE(user_id, conversation_id)` 保证）。
 * 摘要随会话增长而更新，因此不会无限膨胀。
 */
export function upsertMemory(params: {
  userId: number
  conversationId: number
  summary: string
  embedding: number[] | null
  messageCount: number
}): void {
  const { userId, conversationId, summary, embedding, messageCount } = params
  getDb().prepare(`
    INSERT INTO memory (user_id, conversation_id, summary, embedding, message_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, conversation_id) DO UPDATE SET
      summary       = excluded.summary,
      embedding     = excluded.embedding,
      message_count = excluded.message_count,
      created_at    = excluded.created_at
  `).run(
    userId,
    conversationId,
    summary,
    embedding ? toBlob(embedding) : null,
    messageCount,
    Date.now(),
  )
}

/** 某会话已有的记忆（用于「新增消息不足则跳过摘要」的判断） */
export function getMemory(userId: number, conversationId: number): MemoryRow | null {
  const row = getDb()
    .prepare('SELECT * FROM memory WHERE user_id = ? AND conversation_id = ?')
    .get(userId, conversationId) as any
  return row ? toRow(row) : null
}

/** 某用户的全部记忆（按时间倒序） */
export function listMemories(userId: number, limit = 100): MemoryRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM memory WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(userId, limit) as any[]
  return rows.map(toRow)
}

/**
 * 按余弦相似度取 top-k。
 * 没有向量的记忆（生成摘要时 embedding 不可用）不参与相似度检索 —— 与 RAG 的降级策略一致。
 */
export function searchMemories(userId: number, queryEmbedding: number[], k = 3): ScoredMemory[] {
  const rows = getDb()
    .prepare('SELECT * FROM memory WHERE user_id = ? AND embedding IS NOT NULL')
    .all(userId) as any[]

  return rows
    .map((raw) => {
      const vector = fromBlob(raw.embedding)
      if (!vector)
        return null
      return { ...toRow(raw), score: cosineSimilarity(queryEmbedding, vector) }
    })
    .filter((item): item is ScoredMemory => item !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
}

/** 删除某会话的记忆（返回是否确有删除） */
export function deleteMemory(userId: number, conversationId: number): boolean {
  const result = getDb()
    .prepare('DELETE FROM memory WHERE user_id = ? AND conversation_id = ?')
    .run(userId, conversationId)
  return Number(result.changes) > 0
}

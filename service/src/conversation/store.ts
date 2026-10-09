import { getDb } from '../store/db'

/**
 * 会话持久化的数据访问层。
 *
 * **多租户隔离**：所有导出函数的第一个参数都是 `userId`，且每条 SQL 都带
 * `user_id = ?` 过滤（messages 表本身没有 user_id，一律先经 conversations
 * 定位归属，不存在「按 id 直查消息」的旁路）。
 */

/** 一条消息的存储形态（与前端 `Chat.Chat` 对应，瞬时态如 loading 不入库） */
export interface StoredMessage {
  role: 'user' | 'assistant'
  content: string
  /** Agent 步骤流（前端 `Chat.AgentStep[]`），无则省略 */
  agentSteps?: unknown
  /** 其余展示字段：dateTime / inversion / error / quote / requestOptions / conversationOptions */
  meta?: Record<string, any> | null
  createdAt: number
}

export interface StoredConversation {
  uuid: number
  title: string
  createdAt: number
  updatedAt: number
  messages: StoredMessage[]
}

/** 会话元信息（不含消息体，用于侧边栏列表） */
export interface ConversationMeta {
  uuid: number
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
}

function parseJson(text: unknown): any {
  if (typeof text !== 'string' || text === '')
    return null
  try {
    return JSON.parse(text)
  }
  catch {
    // 库里出现坏 JSON 时不让整个列表接口挂掉
    return null
  }
}

function loadMessages(conversationId: number): StoredMessage[] {
  const rows = getDb().prepare(`
    SELECT role, content, agent_steps_json, meta_json, created_at
    FROM messages
    WHERE conversation_id = ?
    ORDER BY id ASC
  `).all(conversationId) as any[]

  return rows.map(row => ({
    role: row.role === 'user' ? 'user' : 'assistant',
    content: String(row.content ?? ''),
    ...(row.agent_steps_json ? { agentSteps: parseJson(row.agent_steps_json) } : {}),
    ...(row.meta_json ? { meta: parseJson(row.meta_json) } : {}),
    createdAt: Number(row.created_at),
  }))
}

/** 会话元信息列表，按最近更新排序 */
export function listConversations(userId: number): ConversationMeta[] {
  const rows = getDb().prepare(`
    SELECT c.uuid, c.title, c.created_at, c.updated_at,
           (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
    FROM conversations c
    WHERE c.user_id = ?
    ORDER BY c.updated_at DESC, c.uuid DESC
  `).all(userId) as any[]

  return rows.map(row => ({
    uuid: Number(row.uuid),
    title: String(row.title ?? ''),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    messageCount: Number(row.message_count),
  }))
}

/**
 * 取会话（含消息）。`uuid` 省略时返回该用户的全部会话 —— 前端启动时用一次
 * 请求完成整体水合，避免 N 个会话发 N 次请求。
 */
export function getConversations(userId: number, uuid?: number): StoredConversation[] {
  const db = getDb()
  const rows = (uuid === undefined
    ? db.prepare(`
        SELECT id, uuid, title, created_at, updated_at
        FROM conversations WHERE user_id = ?
        ORDER BY updated_at DESC, uuid DESC
      `).all(userId)
    : db.prepare(`
        SELECT id, uuid, title, created_at, updated_at
        FROM conversations WHERE user_id = ? AND uuid = ?
      `).all(userId, uuid)) as any[]

  return rows.map(row => ({
    uuid: Number(row.uuid),
    title: String(row.title ?? ''),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    messages: loadMessages(Number(row.id)),
  }))
}

/**
 * 全量保存：按 uuid upsert 传入的会话，并**裁掉**该用户其余会话。
 *
 * 语义与前端 localStorage 的「整份状态覆盖写」一致，因此删除会话无需单独的
 * 客户端调用 —— 下一次全量同步自然会把服务端的陈旧数据裁掉。
 * 整体在一个事务里，避免半途失败留下「新消息 + 旧会话列表」的混合态。
 */
export function saveConversations(userId: number, conversations: StoredConversation[]): { saved: number; deleted: number } {
  const db = getDb()

  const upsert = db.prepare(`
    INSERT INTO conversations (uuid, user_id, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, uuid) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at
  `)
  const findId = db.prepare('SELECT id FROM conversations WHERE user_id = ? AND uuid = ?')
  const clearMessages = db.prepare('DELETE FROM messages WHERE conversation_id = ?')
  const insertMessage = db.prepare(`
    INSERT INTO messages (conversation_id, role, content, agent_steps_json, meta_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)

  const before = listConversations(userId).length
  const kept: number[] = []

  db.exec('BEGIN')
  try {
    for (const conversation of conversations) {
      upsert.run(
        conversation.uuid,
        userId,
        conversation.title,
        conversation.createdAt,
        conversation.updatedAt,
      )
      const row = findId.get(userId, conversation.uuid) as any
      const conversationId = Number(row.id)

      // 消息整体替换：增量 diff 需要消息级 id，而前端只认下标，替换更简单也更不易错
      clearMessages.run(conversationId)
      for (const message of conversation.messages) {
        insertMessage.run(
          conversationId,
          message.role,
          message.content,
          message.agentSteps === undefined ? null : JSON.stringify(message.agentSteps),
          message.meta ? JSON.stringify(message.meta) : null,
          message.createdAt,
        )
      }
      kept.push(conversation.uuid)
    }

    // 裁剪：不在本次提交里的会话连同其消息一并删除
    if (kept.length > 0) {
      const placeholders = kept.map(() => '?').join(',')
      db.prepare(`
        DELETE FROM messages WHERE conversation_id IN (
          SELECT id FROM conversations WHERE user_id = ? AND uuid NOT IN (${placeholders})
        )
      `).run(userId, ...kept)
      db.prepare(`DELETE FROM conversations WHERE user_id = ? AND uuid NOT IN (${placeholders})`).run(userId, ...kept)
    }
    else {
      db.prepare(`
        DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id = ?)
      `).run(userId)
      db.prepare('DELETE FROM conversations WHERE user_id = ?').run(userId)
    }

    db.exec('COMMIT')
  }
  catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  return { saved: kept.length, deleted: Math.max(0, before - kept.length) }
}

/** 删除单个会话（连带消息）。返回是否确有删除 —— 他人的 uuid 一律返回 false */
export function deleteConversation(userId: number, uuid: number): boolean {
  const db = getDb()
  const row = db.prepare('SELECT id FROM conversations WHERE user_id = ? AND uuid = ?').get(userId, uuid) as any
  if (!row)
    return false

  const conversationId = Number(row.id)
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId)
    db.prepare('DELETE FROM conversations WHERE id = ?').run(conversationId)
    db.exec('COMMIT')
  }
  catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return true
}

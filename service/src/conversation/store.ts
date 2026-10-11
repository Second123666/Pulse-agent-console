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

/** 一条消息检索命中 */
export interface MessageSearchHit {
  conversationUuid: number
  conversationTitle: string
  role: 'user' | 'assistant'
  /** 命中片段：折叠换行 + 截取命中词前后各若干字，两端越界时补省略号 */
  snippet: string
  /** 命中词在 snippet 中的区间（下标相对 snippet），供前端高亮 */
  matchStart: number
  matchEnd: number
  /** 该消息在所属会话中的下标（0 起）—— 与 getConversations 的 messages 顺序一致，前端凭它定位 */
  messageIndex: number
  createdAt: number
}

/** 片段里命中词左右各保留的字数 */
const SNIPPET_RADIUS = 40
/** 片段总长上限（命中词本身超长时截断） */
const SNIPPET_MAX = 160
/** 未命中时的兜底片段长度 */
const SNIPPET_HEAD = 80

/** LIKE 的转义符。SQLite 的 LIKE 默认没有转义符，不显式声明就搜不了 `%` / `_` 本身 */
const LIKE_ESCAPE = '\\'

/** 转义 LIKE 的通配符，让用户搜 `100%` 时不会退化成「匹配任意内容」 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, ch => `${LIKE_ESCAPE}${ch}`)
}

/**
 * 从正文里截出命中片段。
 *
 * 大小写折叠用 `toLowerCase()` 而非 SQLite 的 LIKE：后者只对 ASCII 折叠，
 * 与 JS 的差异只可能出现在非 ASCII 的大小写对上，那时这里会走兜底分支（不高亮），
 * 不影响「搜到了哪条」的正确性。
 */
function buildSnippet(content: string, query: string): { snippet: string; matchStart: number; matchEnd: number } {
  // 折叠所有空白：正文里的换行会把片段撑成多行，面板里显示不下
  const flat = content.replace(/\s+/g, ' ').trim()
  const index = flat.toLowerCase().indexOf(query.toLowerCase())
  if (index < 0)
    return { snippet: flat.slice(0, SNIPPET_HEAD), matchStart: 0, matchEnd: 0 }

  const start = Math.max(0, index - SNIPPET_RADIUS)
  const end = Math.min(flat.length, index + query.length + SNIPPET_RADIUS)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < flat.length ? '…' : ''
  const snippet = `${prefix}${flat.slice(start, Math.min(end, start + SNIPPET_MAX))}${suffix}`
  const matchStart = prefix.length + (index - start)

  return { snippet, matchStart, matchEnd: matchStart + query.length }
}

/**
 * 跨会话检索消息正文。
 *
 * **多租户隔离**：messages 表没有 user_id，一律 JOIN conversations 并按 `c.user_id = ?`
 * 过滤 —— 不存在「按消息 id 直查」的旁路。
 *
 * 用 LIKE 而非 FTS5：FTS5 的默认分词器（unicode61）不切中文词，中文查询会整段当成
 * 一个 token 而搜不到；上 ICU 分词又要额外的 SQLite 编译选项。本项目的语料是个人
 * 会话（量级几千条），LIKE 的全表扫描完全够用，且中文子串匹配天然正确。
 */
export function searchMessages(userId: number, query: string, limit: number): MessageSearchHit[] {
  const rows = getDb().prepare(`
    SELECT c.uuid AS conversationUuid, c.title AS conversationTitle,
           m.role, m.content, m.created_at,
           (SELECT COUNT(*) FROM messages m2 WHERE m2.conversation_id = m.conversation_id AND m2.id < m.id) AS messageIndex
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.user_id = ? AND m.content LIKE ? ESCAPE '${LIKE_ESCAPE}'
    ORDER BY m.id DESC
    LIMIT ?
  `).all(userId, `%${escapeLike(query)}%`, limit) as any[]

  return rows.map((row) => {
    const content = String(row.content ?? '')
    return {
      conversationUuid: Number(row.conversationUuid),
      conversationTitle: String(row.conversationTitle ?? ''),
      role: row.role === 'user' ? 'user' as const : 'assistant' as const,
      ...buildSnippet(content, query),
      messageIndex: Number(row.messageIndex),
      createdAt: Number(row.created_at),
    }
  })
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

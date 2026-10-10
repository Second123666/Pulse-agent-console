import { getDb } from '../store/db'

/**
 * 用量的数据访问层。
 *
 * **多租户隔离**：与 conversation/store.ts 一致，每个导出函数的第一个参数都是 `userId`，
 * 每条 SQL 都带 `user_id = ?` 过滤。
 *
 * 关于 `conversation_uuid` 的命名：workflow 里写的是 `conversation_id`，这里刻意存**前端 uuid**
 * 而非 `conversations.id` 外键 —— 外键会在会话被删除后变成悬空引用，且写用量时若会话尚未落库
 * 还得先查一次；uuid 是前端本来就有、且与用户所见一一对应的标识，自包含且不会失效。
 */

/** 一次 Agent 运行的用量记录 */
export interface UsageRecord {
  userId: number
  /** 前端会话 uuid；缺失（老客户端未传）时为 null，仍记账 */
  conversationUuid?: number | null
  model: string
  promptTokens: number
  completionTokens: number
  durationMs: number
  createdAt?: number
}

/** 按天聚合的一行 */
export interface UsageDailyRow {
  /** 本地日期 YYYY-MM-DD */
  date: string
  runs: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  durationMs: number
}

/** 按会话聚合的一行 */
export interface UsageConversationRow {
  conversationUuid: number | null
  runs: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  durationMs: number
}

export interface UsageTotals {
  runs: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  durationMs: number
}

export interface UsageSummary {
  /** 聚合窗口（天） */
  days: number
  total: UsageTotals
  daily: UsageDailyRow[]
  conversations: UsageConversationRow[]
}

/** 写入一条用量记录 */
export function recordUsage(record: UsageRecord): void {
  const uuid = record.conversationUuid
  getDb().prepare(`
    INSERT INTO usage (user_id, conversation_uuid, model, prompt_tokens, completion_tokens, duration_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.userId,
    (typeof uuid === 'number' && Number.isInteger(uuid) && uuid > 0) ? uuid : null,
    record.model ?? '',
    Math.max(0, Math.trunc(record.promptTokens)),
    Math.max(0, Math.trunc(record.completionTokens)),
    Math.max(0, Math.trunc(record.durationMs)),
    record.createdAt ?? Date.now(),
  )
}

/** 汇总字段的统一投影，避免三处 SELECT 各写一遍 */
const TOTALS_COLUMNS = `
  COUNT(*) AS runs,
  COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
  COALESCE(SUM(completion_tokens), 0) AS completionTokens,
  COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS totalTokens,
  COALESCE(SUM(duration_ms), 0) AS durationMs
`

/** 把 SQL 聚合行里的字符串/大整数统一成 number（node:sqlite 的 SUM 可能返回 bigint） */
function toNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function normalizeTotals(row: any): UsageTotals {
  return {
    runs: toNumber(row?.runs),
    promptTokens: toNumber(row?.promptTokens),
    completionTokens: toNumber(row?.completionTokens),
    totalTokens: toNumber(row?.totalTokens),
    durationMs: toNumber(row?.durationMs),
  }
}

/**
 * 汇总某用户近 N 天的用量。
 *
 * 按天分组用 SQLite 的 `date(created_at/1000, 'unixepoch', 'localtime')` —— 按用户本地日历日
 * 切分，与「今天用了多少」的直觉一致（UTC 切分会让东八区用户看到跨日错位）。
 */
export function summarizeUsage(userId: number, days: number, now = Date.now()): UsageSummary {
  const db = getDb()
  const windowDays = Math.max(1, Math.trunc(days))
  const since = now - windowDays * 24 * 60 * 60 * 1000

  const total = normalizeTotals(
    db.prepare(`SELECT ${TOTALS_COLUMNS} FROM usage WHERE user_id = ? AND created_at >= ?`).get(userId, since),
  )

  const daily = (db.prepare(`
    SELECT date(created_at / 1000, 'unixepoch', 'localtime') AS date, ${TOTALS_COLUMNS}
    FROM usage
    WHERE user_id = ? AND created_at >= ?
    GROUP BY date
    ORDER BY date DESC
  `).all(userId, since) as any[]).map(row => ({ date: String(row.date), ...normalizeTotals(row) }))

  const conversations = (db.prepare(`
    SELECT conversation_uuid AS conversationUuid, ${TOTALS_COLUMNS}
    FROM usage
    WHERE user_id = ? AND created_at >= ?
    GROUP BY conversation_uuid
    ORDER BY totalTokens DESC
    LIMIT 50
  `).all(userId, since) as any[]).map(row => ({
    conversationUuid: (row.conversationUuid === null || row.conversationUuid === undefined)
      ? null
      : toNumber(row.conversationUuid),
    ...normalizeTotals(row),
  }))

  return { days: windowDays, total, daily, conversations }
}

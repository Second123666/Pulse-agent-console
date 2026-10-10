import type { Request, Response } from 'express'
import express from 'express'
import { requireAuth } from '../middleware/auth'
import type { StoredConversation, StoredMessage } from './store'
import { deleteConversation, getConversations, listConversations, saveConversations, searchMessages } from './store'

export const conversationRouter = express.Router()

// 整个路由都需要登录：会话数据按 user_id 隔离，未登录无从谈起
conversationRouter.use(requireAuth)

/** 单次全量保存的规模上限：挡住畸形/恶意载荷把内存与库撑爆（正常使用远低于此） */
const MAX_CONVERSATIONS = 200
const MAX_MESSAGES_PER_CONVERSATION = 2000

/** 检索：搜索词长度上限（超过只会拖慢全表扫描，且已超出任何真实查询的长度） */
const MAX_SEARCH_QUERY = 100
const DEFAULT_SEARCH_LIMIT = 20
const MAX_SEARCH_LIMIT = 50

function fail(res: Response, status: number, message: string) {
  res.status(status).json({ status: 'Fail', message, data: null })
}

/** 取当前登录用户的 id；JWT 的 sub 是字符串，非法值一律视为未授权 */
function currentUserId(req: Request, res: Response): number | null {
  const id = Number(req.user?.sub)
  if (!Number.isInteger(id) || id <= 0) {
    fail(res, 401, '登录状态无效，请重新登录')
    return null
  }
  return id
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 校验并归一化保存载荷。
 *
 * 选择「严格校验 + 明确 400」而非静默丢弃：静默丢数据会让前端的会话在服务端
 * 悄悄变少，用户只在换设备时才发现，排查成本极高。前端提交的是自己序列化的
 * 结构，正常情况下不会触发这些分支。
 */
function normalizeConversations(input: unknown): { conversations: StoredConversation[] } | { error: string } {
  if (!Array.isArray(input))
    return { error: 'conversations 必须是数组' }

  if (input.length > MAX_CONVERSATIONS)
    return { error: `会话数量超过上限（${MAX_CONVERSATIONS}）` }

  const conversations: StoredConversation[] = []

  for (const raw of input) {
    if (!isPlainObject(raw))
      return { error: '会话必须是对象' }

    const uuid = Number(raw.uuid)
    if (!Number.isInteger(uuid) || uuid <= 0)
      return { error: '会话 uuid 必须是正整数' }

    if (!Array.isArray(raw.messages))
      return { error: '会话 messages 必须是数组' }

    if (raw.messages.length > MAX_MESSAGES_PER_CONVERSATION)
      return { error: `单会话消息数超过上限（${MAX_MESSAGES_PER_CONVERSATION}）` }

    const messages: StoredMessage[] = []
    for (const item of raw.messages) {
      if (!isPlainObject(item))
        return { error: '消息必须是对象' }

      if (item.role !== 'user' && item.role !== 'assistant')
        return { error: '消息 role 只能是 user 或 assistant' }

      if (typeof item.content !== 'string')
        return { error: '消息 content 必须是字符串' }

      const createdAt = Number(item.createdAt)
      messages.push({
        role: item.role,
        content: item.content,
        ...((item.agentSteps === undefined || item.agentSteps === null) ? {} : { agentSteps: item.agentSteps }),
        ...(isPlainObject(item.meta) ? { meta: item.meta } : {}),
        createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
      })
    }

    const createdAt = Number(raw.createdAt)
    const updatedAt = Number(raw.updatedAt)

    conversations.push({
      uuid,
      title: typeof raw.title === 'string' ? raw.title : '',
      createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
      messages,
    })
  }

  return { conversations }
}

/** 全量保存（upsert + 裁剪）。前端 recordState 防抖后调用 */
conversationRouter.post('/conversation/save', (req, res) => {
  const userId = currentUserId(req, res)
  if (userId === null)
    return

  const normalized = normalizeConversations(req.body?.conversations)
  if ('error' in normalized) {
    fail(res, 400, normalized.error)
    return
  }

  try {
    const result = saveConversations(userId, normalized.conversations)
    res.json({ status: 'Success', message: '', data: result })
  }
  catch (error: any) {
    fail(res, 500, error?.message ?? '保存会话失败')
  }
})

/** 会话元信息列表（侧边栏用，不含消息体） */
conversationRouter.post('/conversation/list', (req, res) => {
  const userId = currentUserId(req, res)
  if (userId === null)
    return

  try {
    res.json({ status: 'Success', message: '', data: { conversations: listConversations(userId) } })
  }
  catch (error: any) {
    fail(res, 500, error?.message ?? '读取会话列表失败')
  }
})

/** 取会话（含消息）。不传 uuid 则返回全部 —— 前端启动水合走这条 */
conversationRouter.post('/conversation/get', (req, res) => {
  const userId = currentUserId(req, res)
  if (userId === null)
    return

  const raw = req.body?.uuid
  let uuid: number | undefined
  if (raw !== undefined && raw !== null) {
    uuid = Number(raw)
    if (!Number.isInteger(uuid) || uuid <= 0) {
      fail(res, 400, 'uuid 必须是正整数')
      return
    }
  }

  try {
    res.json({ status: 'Success', message: '', data: { conversations: getConversations(userId, uuid) } })
  }
  catch (error: any) {
    fail(res, 500, error?.message ?? '读取会话失败')
  }
})

/**
 * 跨会话检索消息正文。
 *
 * 用 GET + query 参数（与本文件其余 POST 端点不同）：这是纯读取、无副作用，
 * GET 语义正确，也让结果可被缓存与直接收藏。
 */
conversationRouter.get('/conversation/search', (req, res) => {
  const userId = currentUserId(req, res)
  if (userId === null)
    return

  const raw = typeof req.query?.q === 'string' ? req.query.q.trim() : ''
  if (!raw) {
    fail(res, 400, '搜索词不能为空')
    return
  }
  if (raw.length > MAX_SEARCH_QUERY) {
    fail(res, 400, `搜索词过长（上限 ${MAX_SEARCH_QUERY} 字）`)
    return
  }

  const rawLimit = Number(req.query?.limit)
  const limit = (Number.isFinite(rawLimit) && rawLimit > 0)
    ? Math.min(MAX_SEARCH_LIMIT, Math.trunc(rawLimit))
    : DEFAULT_SEARCH_LIMIT

  try {
    res.json({ status: 'Success', message: '', data: { hits: searchMessages(userId, raw, limit) } })
  }
  catch (error: any) {
    fail(res, 500, error?.message ?? '检索消息失败')
  }
})

/** 删除单个会话（连带消息） */
conversationRouter.post('/conversation/delete', (req, res) => {
  const userId = currentUserId(req, res)
  if (userId === null)
    return

  const uuid = Number(req.body?.uuid)
  if (!Number.isInteger(uuid) || uuid <= 0) {
    fail(res, 400, 'uuid 必须是正整数')
    return
  }

  try {
    // 他人的 uuid 只会得到 deleted: false，不泄露该会话是否存在
    res.json({ status: 'Success', message: '', data: { deleted: deleteConversation(userId, uuid) } })
  }
  catch (error: any) {
    fail(res, 500, error?.message ?? '删除会话失败')
  }
})

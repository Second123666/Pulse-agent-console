import type { Request, Response } from 'express'
import express from 'express'
import { requireAuth } from '../middleware/auth'
import { KnowledgeUploadError, MAX_UPLOAD_BYTES, deleteDocument, ingestDocument, listDocumentsWithStatus, reindexDocument } from './store'

/** docId 是本模块生成的 16 位十六进制；显式校验，防止奇怪的路径参数进到查询里 */
const DOC_ID_PATTERN = /^[0-9a-f]{16}$/i

export const knowledgeRouter = express.Router()

// 整个路由都需要登录：知识库按 user_id 隔离，未登录无从谈起
knowledgeRouter.use(requireAuth)

/** body 里 base64 载荷的字符上限（对应 MAX_UPLOAD_BYTES 解码后的大小） */
const MAX_BASE64_CHARS = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 8

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

/**
 * 解 base64，**失败返回 null** 而不是抛错或静默返回乱码。
 *
 * 关键是回环校验：纯文本直接喂给 `Buffer.from(x, 'base64')` 也能"成功"解出东西，
 * 不做校验的话用户把原文当 base64 传进来会被切成一堆乱码入库 —— 那时已经晚了。
 */
function decodeBase64(input: string): string | null {
  const normalized = input.replace(/\s+/g, '')
  if (!normalized)
    return null
  // 补齐 padding（前端通常已经补过，但允许不补的写法）
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4)
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(padded))
    return null
  const buffer = Buffer.from(padded, 'base64')
  const reEncoded = buffer.toString('base64').replace(/=+$/, '')
  if (reEncoded !== normalized.replace(/=+$/, ''))
    return null
  return buffer.toString('utf-8')
}

/**
 * 上传文档：`POST /knowledge/upload`，body `{ name, contentBase64 }`。
 *
 * **base64 内联进 JSON body**，复用已有的 `express.json({ limit: '10mb' })` ——
 * 零新依赖（不引 multer）。代价是同体积下比 multipart 贵约 1/3 带宽，
 * 但对「一次一份知识库文档」的量级完全无所谓，换来的是不用处理落盘、
 * 鉴权、文件类型解析、孤儿文件清理一整套东西。
 * 与 Phase 13 的多模态图片走同一条路线，两处代码思路一致。
 */
knowledgeRouter.post('/knowledge/upload', async (req, res) => {
  const userId = currentUserId(req, res)
  if (userId === null)
    return

  const { name, contentBase64 } = req.body ?? {}

  if (typeof name !== 'string' || !name.trim())
    return fail(res, 400, '缺少文件名')
  if (typeof contentBase64 !== 'string' || !contentBase64)
    return fail(res, 400, '缺少文件内容（contentBase64）')
  if (contentBase64.length > MAX_BASE64_CHARS)
    return fail(res, 400, `文件过大，上限 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB`)

  const content = decodeBase64(contentBase64)
  if (content === null)
    return fail(res, 400, '文件内容不是合法的 base64')

  try {
    const doc = await ingestDocument({ userId, name: name.trim(), content })
    res.json({ status: 'Success', message: '', data: { doc } })
  }
  catch (error: any) {
    if (error instanceof KnowledgeUploadError)
      return fail(res, 400, error.message)
    fail(res, 500, error?.message ?? '上传失败')
  }
})

/**
 * 文档列表：`GET /knowledge/list`，带索引状态（登记块数 vs 实际向量块数）。
 *
 * 全部按 `userId` 过滤 —— 与 `conversation/routes.ts` 的多租户约定一致：
 * 会话是靠 JOIN 隔离，这里靠 `VectorRecord.userId` 与 `knowledge_docs.user_id`。
 */
knowledgeRouter.get('/knowledge/list', async (req, res) => {
  const userId = currentUserId(req, res)
  if (userId === null)
    return

  try {
    const docs = await listDocumentsWithStatus(userId)
    res.json({ status: 'Success', message: '', data: { docs } })
  }
  catch (error: any) {
    fail(res, 500, error?.message ?? '列表获取失败')
  }
})

/**
 * 删除文档：`DELETE /knowledge/:docId`。
 *
 * 删除条件是 **`user_id` + `doc_id` 双条件** —— 只按 docId 删的话，猜到别人的
 * docId 就能删别人的文档。deleteDocument 内部已经带了双条件，这里再校验一次 id 格式。
 * 他人文档 / 不存在一律回 404（**不区分**，避免暴露「这个 id 存在但不是你的」）。
 */
knowledgeRouter.delete('/knowledge/:docId', async (req, res) => {
  const userId = currentUserId(req, res)
  if (userId === null)
    return

  const docId = String(req.params.docId ?? '')
  if (!DOC_ID_PATTERN.test(docId))
    return fail(res, 400, '文档 id 非法')

  try {
    const result = await deleteDocument(userId, docId)
    if (!result)
      return fail(res, 404, '文档不存在')
    res.json({ status: 'Success', message: '', data: result })
  }
  catch (error: any) {
    fail(res, 500, error?.message ?? '删除失败')
  }
})

/**
 * 重建索引：`POST /knowledge/reindex`，body `{ docId }`。
 * 用于 embedding 配置变更后把已有文档重新向量化。
 */
knowledgeRouter.post('/knowledge/reindex', async (req, res) => {
  const userId = currentUserId(req, res)
  if (userId === null)
    return

  const { docId } = req.body ?? {}
  if (typeof docId !== 'string' || !DOC_ID_PATTERN.test(docId))
    return fail(res, 400, '文档 id 非法')

  try {
    const result = await reindexDocument(userId, docId)
    if (!result)
      return fail(res, 404, '文档不存在')
    res.json({ status: 'Success', message: '', data: result })
  }
  catch (error: any) {
    if (error instanceof KnowledgeUploadError)
      return fail(res, 400, error.message)
    fail(res, 500, error?.message ?? '重建失败')
  }
})

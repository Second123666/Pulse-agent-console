import type { Request, Response } from 'express'
import express from 'express'
import { requireAuth } from '../middleware/auth'
import { KnowledgeUploadError, MAX_UPLOAD_BYTES, ingestDocument } from './store'

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

import type { Request, Response } from 'express'
import express from 'express'
import { requireAuth } from '../middleware/auth'
import { summarizeUsage } from './store'

export const usageRouter = express.Router()

// 用量按 user_id 隔离，未登录无从谈起（与 conversationRouter 一致）
usageRouter.use(requireAuth)

/** 聚合窗口上限：挡住 `?days=999999` 之类的全表扫描 */
const MAX_DAYS = 365
const DEFAULT_DAYS = 30

function fail(res: Response, status: number, message: string) {
  res.status(status).json({ status: 'Fail', message, data: null })
}

/** 用量汇总（按天 + 按会话）。`?days=` 缺省 30 天 */
usageRouter.get('/usage/summary', (req: Request, res: Response) => {
  // JWT 的 sub 是字符串，非法值一律视为未授权（与 conversation/routes.ts 同一判据）
  const userId = Number(req.user?.sub)
  if (!Number.isInteger(userId) || userId <= 0) {
    fail(res, 401, '登录状态无效，请重新登录')
    return
  }

  const rawDays = Number(req.query?.days)
  const days = (Number.isFinite(rawDays) && rawDays > 0)
    ? Math.min(MAX_DAYS, Math.trunc(rawDays))
    : DEFAULT_DAYS

  try {
    res.json({ status: 'Success', message: '', data: summarizeUsage(userId, days) })
  }
  catch (error: any) {
    fail(res, 500, error?.message ?? '读取用量汇总失败')
  }
})

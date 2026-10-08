import type { NextFunction, Request, Response } from 'express'
import type { JwtPayload } from '../auth/jwt'
import { verifyToken } from '../auth/jwt'
import { getJwtSecret } from '../auth/secret'

declare global {
  namespace Express {
    interface Request {
      /** requireAuth 通过后挂载的当前登录用户（来自 JWT 载荷） */
      user?: JwtPayload
    }
  }
}

const BEARER_PREFIX = 'Bearer '

/**
 * 登录校验中间件：校验 `Authorization: Bearer <jwt>`。
 *
 * 这是修掉「后端零鉴权」漏洞的关键 —— 在此中间件挂上之前，任何人都能
 * 直接 curl /agent-process、/chat-process 消耗服务端 API key 与额度。
 * JWT 为无状态校验，不查库；因此数据库故障不影响已登录用户的对话。
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? ''
  const token = header.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length).trim() : ''

  if (!token) {
    res.status(401).json({ status: 'Fail', message: '未登录：缺少 Authorization: Bearer <token>', data: null })
    return
  }

  const payload = verifyToken(token, getJwtSecret())
  if (!payload) {
    res.status(401).json({ status: 'Fail', message: '登录状态无效或已过期，请重新登录', data: null })
    return
  }

  req.user = payload
  next()
}

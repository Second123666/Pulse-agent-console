import express from 'express'
import { authLimiter } from '../middleware/limiter'
import { requireAuth } from '../middleware/auth'
import { authConfig } from '../utils/config'
import { signToken } from './jwt'
import { getJwtSecret } from './secret'
import type { UserRow } from './users'
import { DuplicateUsernameError, authenticate, createUser, toPublicUser } from './users'
import { validateInvite, validatePassword, validateUsername } from './validate'

export const authRouter = express.Router()

/** 登录成功 / 注册成功的统一响应体：签发 token + 返回公开用户信息 */
function issueSession(row: UserRow) {
  const token = signToken(
    { sub: String(row.id), name: row.username, role: row.role },
    getJwtSecret(),
    authConfig.tokenTtlSeconds,
  )
  return { token, user: toPublicUser(row) }
}

/**
 * 注册。首个注册用户成为管理员（bootstrap）。
 * 若配置了 AUTH_SECRET_KEY（现语义为注册邀请码），则必须携带且匹配。
 */
authRouter.post('/auth/register', [authLimiter], async (req, res) => {
  const { username, password, inviteCode } = req.body ?? {}

  const invalid = validateUsername(username)
    ?? validatePassword(password)
    ?? validateInvite(inviteCode, authConfig.inviteCode)

  if (invalid) {
    res.status(400).json({ status: 'Fail', message: invalid, data: null })
    return
  }

  try {
    const row = await createUser(username, password)
    res.status(201).json({ status: 'Success', message: '', data: issueSession(row) })
  }
  catch (error: any) {
    if (error instanceof DuplicateUsernameError) {
      res.status(409).json({ status: 'Fail', message: error.message, data: null })
      return
    }
    res.status(500).json({ status: 'Fail', message: error?.message ?? '注册失败', data: null })
  }
})

/** 登录：用户名 + 密码 → JWT。失败一律返回同一句提示，不区分「用户不存在 / 密码错误」 */
authRouter.post('/auth/login', [authLimiter], async (req, res) => {
  const { username, password } = req.body ?? {}

  if (typeof username !== 'string' || typeof password !== 'string') {
    res.status(400).json({ status: 'Fail', message: '缺少用户名或密码', data: null })
    return
  }

  try {
    const row = await authenticate(username, password)
    if (!row) {
      res.status(401).json({ status: 'Fail', message: '用户名或密码错误', data: null })
      return
    }
    res.json({ status: 'Success', message: '', data: issueSession(row) })
  }
  catch (error: any) {
    res.status(500).json({ status: 'Fail', message: error?.message ?? '登录失败', data: null })
  }
})

/** 当前登录用户（前端启动时校验登录态用） */
authRouter.get('/auth/me', [requireAuth], (req, res) => {
  const { sub, name, role } = req.user!
  res.json({ status: 'Success', message: '', data: { user: { id: Number(sub), username: name, role } } })
})

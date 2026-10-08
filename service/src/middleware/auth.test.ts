import type { NextFunction, Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { signToken } from '../auth/jwt'
import { getJwtSecret } from '../auth/secret'
import { requireAuth } from './auth'

const CLAIMS = { sub: '1', name: 'alice', role: 'admin' }

function makeReq(authorization?: string): Request {
  return { headers: authorization === undefined ? {} : { authorization } } as Request
}

function makeRes() {
  const res: any = {}
  res.status = vi.fn(() => res)
  res.json = vi.fn(() => res)
  return res as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> }
}

describe('requireAuth', () => {
  it('无 Authorization 头 → 401 且不放行', () => {
    const res = makeRes()
    const next = vi.fn()

    requireAuth(makeReq(), res, next as unknown as NextFunction)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('非 Bearer 方案 → 401', () => {
    const res = makeRes()
    const next = vi.fn()

    requireAuth(makeReq('Basic YWxpY2U6cHc='), res, next as unknown as NextFunction)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('token 被篡改 / 用其它密钥签发 → 401', () => {
    const forged = signToken(CLAIMS, 'wrong-secret', 60)
    const expired = signToken(CLAIMS, getJwtSecret(), -1)

    for (const token of [forged, expired, 'not-a-token']) {
      const res = makeRes()
      const next = vi.fn()
      requireAuth(makeReq(`Bearer ${token}`), res, next as unknown as NextFunction)
      expect(res.status).toHaveBeenCalledWith(401)
      expect(next).not.toHaveBeenCalled()
    }
  })

  it('合法 token → 挂载 req.user 并放行', () => {
    const token = signToken(CLAIMS, getJwtSecret(), 60)
    const req = makeReq(`Bearer ${token}`)
    const res = makeRes()
    const next = vi.fn()

    requireAuth(req, res, next as unknown as NextFunction)

    expect(next).toHaveBeenCalledOnce()
    expect(req.user).toMatchObject(CLAIMS)
    expect(res.status).not.toHaveBeenCalled()
  })
})

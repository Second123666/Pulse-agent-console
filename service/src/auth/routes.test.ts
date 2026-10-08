import type { Server } from 'node:http'
import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

// 环境必须在**动态 import 之前**设置：authConfig 在模块求值时读取 env，
// 而 dotenv 不会覆盖已存在的变量（空字符串也算已存在），因此这里的值生效。
process.env.AGENT_DB_PATH = ':memory:'
process.env.AUTH_SECRET_KEY = '' // 开放注册（邀请码路径由 validate.test.ts 覆盖）
process.env.JWT_SECRET = 'test-jwt-secret'

const { authRouter } = await import('./routes')
const { requireAuth } = await import('../middleware/auth')
const { getDb } = await import('../store/db')

let server: Server
let base: string

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  // 与 index.ts 相同的双前缀挂载方式
  app.use('', authRouter)
  app.use('/api', authRouter)
  // 用 requireAuth 保护一个占位端点，验证「无 token → 401」这条核心安全属性
  // 与 index.ts 一致：同一处理器挂在 '' 与 '/api' 两个前缀下
  const protectedHandler = (_req: express.Request, res: express.Response) => {
    res.json({ status: 'Success', message: 'should not reach without token', data: null })
  }
  app.post('/agent-process', [requireAuth], protectedHandler)
  app.post('/api/agent-process', [requireAuth], protectedHandler)

  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve)
  })
  const address = server.address()
  const port = (typeof address === 'object' && address) ? address.port : 0
  base = `http://127.0.0.1:${port}`
})

afterAll(() => {
  server?.close()
})

beforeEach(() => {
  getDb().exec('DELETE FROM users')
})

/** 注册一个用户并返回响应，供各用例复用 */
async function register(username: string, password: string) {
  const response = await fetch(`${base}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  return { response, body: await response.json() as any }
}

describe('鉴权端点（HTTP 级）', () => {
  it('无 token 打受保护端点 → 401（修复前的漏洞：任何人可 curl 消耗 API key）', async () => {
    const response = await fetch(`${base}/agent-process`, { method: 'POST' })
    expect(response.status).toBe(401)

    // /api 前缀同样受保护
    const viaApi = await fetch(`${base}/api/agent-process`, { method: 'POST' })
    expect(viaApi.status).toBe(401)
  })

  it('伪造 / 过期 token → 401', async () => {
    const response = await fetch(`${base}/agent-process`, {
      method: 'POST',
      headers: { Authorization: 'Bearer not-a-real-token' },
    })
    expect(response.status).toBe(401)
  })

  it('注册 → 首个用户为 admin，返回 token 且可访问受保护端点', async () => {
    const { response, body } = await register('alice', 'password-1')
    expect(response.status).toBe(201)
    expect(body.data.user).toMatchObject({ username: 'alice', role: 'admin' })
    expect(typeof body.data.token).toBe('string')

    const protectedResponse = await fetch(`${base}/agent-process`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${body.data.token}` },
    })
    expect(protectedResponse.status).toBe(200)
  })

  it('第二个注册用户为普通用户；重复用户名 → 409', async () => {
    await register('alice', 'password-1')
    const { body } = await register('bob', 'password-2')
    expect(body.data.user.role).toBe('user')

    const { response: dup } = await register('alice', 'password-3')
    expect(dup.status).toBe(409)
  })

  it('登录：正确密码返回 token，错误密码 401', async () => {
    await register('alice', 'password-1')

    const ok = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'password-1' }),
    })
    expect(ok.status).toBe(200)
    expect(typeof (await ok.json() as any).data.token).toBe('string')

    const bad = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'wrong-password' }),
    })
    expect(bad.status).toBe(401)

    const nobody = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'nobody', password: 'password-1' }),
    })
    expect(nobody.status).toBe(401)
  })

  it('GET /auth/me：带 token 返回当前用户，无 token 401', async () => {
    const { body } = await register('alice', 'password-1')

    const me = await fetch(`${base}/auth/me`, {
      headers: { Authorization: `Bearer ${body.data.token}` },
    })
    expect(me.status).toBe(200)
    expect((await me.json() as any).data.user).toMatchObject({ username: 'alice', role: 'admin' })

    const anonymous = await fetch(`${base}/auth/me`)
    expect(anonymous.status).toBe(401)
  })

  it('注册入参校验：短密码 / 非法用户名 → 400', async () => {
    const { response: shortPwd, body: shortPwdBody } = await register('alice', 'short')
    expect(shortPwd.status).toBe(400)
    expect(shortPwdBody.message).toContain('密码')

    const { response: badName } = await register('a', 'password-1')
    expect(badName.status).toBe(400)
  })

  it('响应体不泄露 password_hash / salt', async () => {
    const { body } = await register('alice', 'password-1')
    const serialized = JSON.stringify(body)

    expect(serialized).not.toContain('password_hash')
    expect(serialized).not.toContain('salt')
    expect(serialized).not.toContain('password-1')
  })
})

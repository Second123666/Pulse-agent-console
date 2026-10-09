import type { Server } from 'node:http'
import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

// 环境必须在**动态 import 之前**设置（authConfig 在模块求值时读 env）
process.env.AGENT_DB_PATH = ':memory:'
process.env.AUTH_SECRET_KEY = ''
process.env.JWT_SECRET = 'test-jwt-secret'

const { conversationRouter } = await import('./routes')
const { authRouter } = await import('../auth/routes')
const { getDb } = await import('../store/db')

let server: Server
let base: string

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  // 与 index.ts 相同的双前缀挂载
  app.use('', authRouter)
  app.use('/api', authRouter)
  app.use('', conversationRouter)
  app.use('/api', conversationRouter)

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
  const db = getDb()
  db.exec('DELETE FROM messages')
  db.exec('DELETE FROM conversations')
  db.exec('DELETE FROM users')
})

async function register(username: string): Promise<string> {
  const response = await fetch(`${base}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'password-1' }),
  })
  const body = await response.json() as any
  return body.data.token as string
}

/** 带 token 调用 /conversation/* */
async function call(path: string, token: string | null, payload?: any) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload ?? {}),
  })
  return { response, body: await response.json() as any }
}

/** 造一条前端形态的会话（uuid / title / messages 与 Chat.ChatState 对应） */
function conversation(uuid: number, title: string, texts: string[] = ['你好']) {
  return {
    uuid,
    title,
    createdAt: 1700000000000,
    updatedAt: 1700000000000 + uuid,
    messages: texts.map((text, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: text,
      createdAt: 1700000000000 + index,
      meta: { dateTime: '2026-10-09 10:00:00', inversion: index % 2 === 0 },
      ...(index % 2 === 1 ? { agentSteps: [{ type: 'thought', content: '先算一下' }] } : {}),
    })),
  }
}

describe('会话持久化端点（HTTP 级）', () => {
  it('无 token 打四个端点 → 全部 401', async () => {
    for (const path of ['/conversation/save', '/conversation/list', '/conversation/get', '/conversation/delete']) {
      const { response } = await call(path, null, { conversations: [], uuid: 1 })
      expect(response.status, path).toBe(401)
    }
  })

  it('/api 前缀同样受保护且可用', async () => {
    const anonymous = await call('/api/conversation/list', null)
    expect(anonymous.response.status).toBe(401)

    const token = await register('alice')
    const { response, body } = await call('/api/conversation/list', token)
    expect(response.status).toBe(200)
    expect(body.data.conversations).toEqual([])
  })

  it('保存 → 列表 / 读取一致，agentSteps 与 meta 往返不丢', async () => {
    const token = await register('alice')

    const save = await call('/conversation/save', token, { conversations: [conversation(1002, '第一次对话', ['你好', '你好呀'])] })
    expect(save.response.status).toBe(200)
    expect(save.body.data).toMatchObject({ saved: 1, deleted: 0 })

    const list = await call('/conversation/list', token)
    expect(list.body.data.conversations).toHaveLength(1)
    expect(list.body.data.conversations[0]).toMatchObject({ uuid: 1002, title: '第一次对话', messageCount: 2 })

    const got = await call('/conversation/get', token, { uuid: 1002 })
    const [stored] = got.body.data.conversations
    expect(stored.messages).toHaveLength(2)
    expect(stored.messages[0]).toMatchObject({ role: 'user', content: '你好' })
    expect(stored.messages[1].content).toBe('你好呀')
    expect(stored.messages[1].agentSteps).toEqual([{ type: 'thought', content: '先算一下' }])
    expect(stored.messages[1].meta).toMatchObject({ dateTime: '2026-10-09 10:00:00' })
  })

  it('不传 uuid 的 /conversation/get 返回全部会话（前端启动水合用）', async () => {
    const token = await register('alice')
    await call('/conversation/save', token, { conversations: [conversation(1, 'A'), conversation(2, 'B')] })

    const got = await call('/conversation/get', token)
    expect(got.body.data.conversations).toHaveLength(2)
    expect(got.body.data.conversations.map((c: any) => c.uuid).sort()).toEqual([1, 2])
    expect(got.body.data.conversations[0].messages.length).toBeGreaterThan(0)
  })

  it('同一 uuid 重复保存 → upsert 覆盖消息而非追加', async () => {
    const token = await register('alice')
    await call('/conversation/save', token, { conversations: [conversation(1002, '旧', ['一', '二', '三'])] })
    await call('/conversation/save', token, { conversations: [conversation(1002, '新', ['一'])] })

    const got = await call('/conversation/get', token, { uuid: 1002 })
    expect(got.body.data.conversations).toHaveLength(1)
    expect(got.body.data.conversations[0].title).toBe('新')
    expect(got.body.data.conversations[0].messages).toHaveLength(1)
  })

  it('全量保存会裁掉未提交的会话（连同其消息）', async () => {
    const token = await register('alice')
    await call('/conversation/save', token, { conversations: [conversation(1, 'A'), conversation(2, 'B')] })

    const second = await call('/conversation/save', token, { conversations: [conversation(2, 'B')] })
    expect(second.body.data).toMatchObject({ saved: 1, deleted: 1 })

    const list = await call('/conversation/list', token)
    expect(list.body.data.conversations.map((c: any) => c.uuid)).toEqual([2])

    // 消息也一并清掉，不留孤儿行
    const orphans = getDb().prepare(`
      SELECT COUNT(*) AS n FROM messages WHERE conversation_id NOT IN (SELECT id FROM conversations)
    `).get() as any
    expect(Number(orphans.n)).toBe(0)
  })

  it('保存空数组 → 清空该用户全部会话', async () => {
    const token = await register('alice')
    await call('/conversation/save', token, { conversations: [conversation(1, 'A')] })

    const cleared = await call('/conversation/save', token, { conversations: [] })
    expect(cleared.body.data).toMatchObject({ saved: 0, deleted: 1 })

    const list = await call('/conversation/list', token)
    expect(list.body.data.conversations).toEqual([])
  })

  it('多租户隔离：bob 看不到、读不到、删不掉 alice 的会话', async () => {
    const alice = await register('alice')
    const bob = await register('bob')
    await call('/conversation/save', alice, { conversations: [conversation(1002, 'alice 的会话')] })

    const bobList = await call('/conversation/list', bob)
    expect(bobList.body.data.conversations).toEqual([])

    const bobGet = await call('/conversation/get', bob, { uuid: 1002 })
    expect(bobGet.body.data.conversations).toEqual([])

    const bobDelete = await call('/conversation/delete', bob, { uuid: 1002 })
    expect(bobDelete.body.data.deleted).toBe(false)

    // alice 的数据分毫未动
    const aliceList = await call('/conversation/list', alice)
    expect(aliceList.body.data.conversations).toHaveLength(1)

    // bob 的全量保存也裁不掉 alice 的会话（裁剪带 user_id 过滤）
    await call('/conversation/save', bob, { conversations: [] })
    const aliceAfter = await call('/conversation/list', alice)
    expect(aliceAfter.body.data.conversations).toHaveLength(1)
  })

  it('两个用户可以用相同的 uuid（uuid 只在用户内唯一）', async () => {
    const alice = await register('alice')
    const bob = await register('bob')
    await call('/conversation/save', alice, { conversations: [conversation(1002, 'alice')] })
    await call('/conversation/save', bob, { conversations: [conversation(1002, 'bob')] })

    expect((await call('/conversation/get', alice, { uuid: 1002 })).body.data.conversations[0].title).toBe('alice')
    expect((await call('/conversation/get', bob, { uuid: 1002 })).body.data.conversations[0].title).toBe('bob')
  })

  it('删除单个会话', async () => {
    const token = await register('alice')
    await call('/conversation/save', token, { conversations: [conversation(1, 'A'), conversation(2, 'B')] })

    const deleted = await call('/conversation/delete', token, { uuid: 1 })
    expect(deleted.body.data.deleted).toBe(true)

    const again = await call('/conversation/delete', token, { uuid: 1 })
    expect(again.body.data.deleted).toBe(false)

    const list = await call('/conversation/list', token)
    expect(list.body.data.conversations.map((c: any) => c.uuid)).toEqual([2])
  })

  it('载荷校验：非法结构 → 400', async () => {
    const token = await register('alice')

    const notArray = await call('/conversation/save', token, { conversations: 'nope' })
    expect(notArray.response.status).toBe(400)

    const badUuid = await call('/conversation/save', token, { conversations: [{ uuid: 'abc', messages: [] }] })
    expect(badUuid.response.status).toBe(400)

    const badRole = await call('/conversation/save', token, {
      conversations: [{ uuid: 1, title: 'A', messages: [{ role: 'system', content: 'x' }] }],
    })
    expect(badRole.response.status).toBe(400)

    const tooMany = await call('/conversation/save', token, {
      conversations: Array.from({ length: 201 }, (_, i) => conversation(i + 1, 'A')),
    })
    expect(tooMany.response.status).toBe(400)

    const badGetUuid = await call('/conversation/get', token, { uuid: -1 })
    expect(badGetUuid.response.status).toBe(400)
  })

  it('会话标题与消息里的敏感字段不外泄到列表接口', async () => {
    const token = await register('alice')
    await call('/conversation/save', token, { conversations: [conversation(1, 'A')] })

    const list = await call('/conversation/list', token)
    const serialized = JSON.stringify(list.body)
    expect(serialized).not.toContain('password_hash')
    expect(serialized).not.toContain('agent_steps_json')
  })
})

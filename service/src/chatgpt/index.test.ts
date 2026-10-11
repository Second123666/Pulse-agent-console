import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ContentPart, MessageContent } from '../types'

/**
 * 「上游仍在思考」的 fetch：永不返回响应，只在 signal 中止时以 AbortError 拒绝。
 * 用于把「内部超时」与「客户端主动中止」两条路径分开验证 —— 两者都表现为 AbortError，
 * 正是这个模块最容易混淆的地方。
 */
function hangingFetch() {
  return vi.fn((_url: string, init: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
    const fail = () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))
    if (init.signal?.aborted)
      return fail()
    init.signal?.addEventListener('abort', fail)
  }))
}

/** 返回固定 SSE 体的 fetch */
function sseFetch(body: string, status = 200) {
  return vi.fn(async () => new Response(body, { status }))
}

/** timeoutMs 是模块级常量，必须先 stubEnv 再动态 import 才能生效 */
async function loadChatReplyProcess(timeoutMs: string) {
  vi.resetModules()
  vi.stubEnv('TIMEOUT_MS', timeoutMs)
  const mod = await import('./index')
  return mod.chatReplyProcess
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('chatReplyProcess', () => {
  it('客户端主动中止：原样上抛 AbortError，而不是转成 Fail 响应', async () => {
    // 调用方（/chat-process）按 error.name === 'AbortError' 静默处理；
    // 若在此处吞掉并转成 Fail，调用方拿到的是无 name 的普通对象，守卫失效
    const chatReplyProcess = await loadChatReplyProcess('100000')
    vi.stubGlobal('fetch', hangingFetch())

    const controller = new AbortController()
    const pending = chatReplyProcess({ message: '你好', signal: controller.signal })
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('内部超时：返回 Fail 且提示为 Request timed out（不能因中止逻辑被吞掉）', async () => {
    const chatReplyProcess = await loadChatReplyProcess('30')
    vi.stubGlobal('fetch', hangingFetch())

    // 不传 signal：超时是「服务端自己放弃」，必须报给用户
    await expect(chatReplyProcess({ message: '你好' })).rejects.toMatchObject({
      status: 'Fail',
      message: 'Request timed out',
    })
  })

  it('上游 HTTP 错误：按错误码返回 Fail（不受中止/超时逻辑影响）', async () => {
    const chatReplyProcess = await loadChatReplyProcess('100000')
    vi.stubGlobal('fetch', sseFetch('nope', 401))

    await expect(chatReplyProcess({ message: '你好' })).rejects.toMatchObject({
      status: 'Fail',
      message: expect.stringContaining('Incorrect API key'),
    })
  })

  it('正常流：逐块推送累计文本，并以 Success 收尾', async () => {
    const chatReplyProcess = await loadChatReplyProcess('100000')
    const sse = [
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
      'data: [DONE]\n\n',
    ].join('')
    vi.stubGlobal('fetch', sseFetch(sse))

    const seen: string[] = []
    const result: any = await chatReplyProcess({
      message: '你好',
      process: chat => seen.push(chat.text),
    })

    // 每帧推的是全量累计文本（前端据此直接覆盖，不做拼接）；
    // 末尾多一帧是循环外的收尾 emit（保证最后一份状态一定送达，内容与前帧相同）
    expect(seen).toEqual(['你', '你好', '你好'])
    expect(result.status).toBe('Success')
    expect(result.data.text).toBe('你好')
  })
})

describe('content 类型放开（13.1）', () => {
  const SSE = 'data: {"choices":[{"delta":{"content":"看"}}]}\ndata: [DONE]\n\n'
  const IMAGE_PART = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }

  /** 打一次请求，返回 [上游收到的 messages, chatReplyProcess 的返回值] */
  async function send(message: any) {
    const chatReplyProcess = await loadChatReplyProcess('100000')
    // 请求体在 mock 里当场记下来，不去索引 mock.calls 的元组（零参 vi.fn 的 calls 是空元组，取下标过不了类型检查）
    let requestBody = ''
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body?: unknown }) => {
      requestBody = String(init.body)
      return new Response(SSE, { status: 200 })
    }))
    const result: any = await chatReplyProcess({ message })
    return [JSON.parse(requestBody).messages, result] as const
  }

  it('老格式（字符串 prompt）在请求体里仍是字符串，不被包装', async () => {
    const [messages, result] = await send('你好')
    const last = messages.at(-1)
    expect(last.role).toBe('user')
    expect(typeof last.content).toBe('string')
    expect(last.content).toBe('你好')
    expect(result.status).toBe('Success')
    expect(result.data.text).toBe('看')
  })

  it('数组 prompt 原样发给上游，回复链路与纯文本一致', async () => {
    const parts = [{ type: 'text', text: '这张图里是什么' }, IMAGE_PART]
    const [messages, result] = await send(parts)
    const last = messages.at(-1)
    expect(Array.isArray(last.content)).toBe(true)
    expect(last.content).toEqual(parts)
    expect(result.status).toBe('Success')
    expect(result.data.text).toBe('看')
  })
})

describe('多模态降级（13.4）', () => {
  const SSE = 'data: {"choices":[{"delta":{"content":"看"}}]}\ndata: [DONE]\n\n'
  const IMAGE_PART: ContentPart = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
  // 显式标 MessageContent：否则字面量里 type 会被推宽成 string，过不了参数类型
  const PROMPT_PARTS: MessageContent = [{ type: 'text', text: '这张图里是什么' }, IMAGE_PART]

  /**
   * 按队列依次应答，并把每次上游请求体当场记下来（队列耗尽后重复最后一项）。
   * 降级路径要断言的是「第二次请求长什么样」，必须拿到逐次的 body，不能只看调用次数
   */
  function queuedFetch(responses: Array<{ status: number; body?: string }>) {
    const requests: any[] = []
    const mock = vi.fn(async (_url: string, init: { body?: unknown }) => {
      requests.push(JSON.parse(String(init.body)))
      const step = responses[Math.min(requests.length - 1, responses.length - 1)]
      return new Response(step.body ?? (step.status === 200 ? SSE : 'rejected'), { status: step.status })
    })
    vi.stubGlobal('fetch', mock)
    return { requests, mock }
  }

  it('上游拒绝图片：剥图重试一次，成功后随帧带出降级提示', async () => {
    const chatReplyProcess = await loadChatReplyProcess('100000')
    const { requests, mock } = queuedFetch([{ status: 400 }, { status: 200 }])
    const frames: any[] = []

    const result: any = await chatReplyProcess({ message: PROMPT_PARTS, process: chat => frames.push(chat) })

    expect(mock).toHaveBeenCalledTimes(2)
    // 第一次带图去、被拒
    expect(Array.isArray(requests[0].messages.at(-1).content)).toBe(true)
    // 第二次：全部消息都是纯字符串，且文字一个字没丢
    expect(requests[1].messages.every((m: any) => typeof m.content === 'string')).toBe(true)
    expect(requests[1].messages.at(-1).content).toBe('这张图里是什么')
    expect(result.status).toBe('Success')
    expect(result.data.notice).toBe('当前模型不支持图片，已按纯文本发送')
    // 提示挂在每一帧上（前端去重），没有帧漏带
    expect(frames.length).toBeGreaterThan(0)
    expect(frames.every(chat => chat.notice === result.data.notice)).toBe(true)
  })

  it('剥图重试后仍失败：报第二次的错，且不带降级提示', async () => {
    const chatReplyProcess = await loadChatReplyProcess('100000')
    const { mock } = queuedFetch([{ status: 400 }, { status: 401 }])

    await expect(chatReplyProcess({ message: PROMPT_PARTS })).rejects.toMatchObject({
      status: 'Fail',
      message: expect.stringContaining('Incorrect API key'),
    })
    expect(mock).toHaveBeenCalledTimes(2)
  })

  it('上游接受图片（多模态模型）：一次成功，不产生降级提示', async () => {
    const chatReplyProcess = await loadChatReplyProcess('100000')
    const { mock } = queuedFetch([{ status: 200 }])
    const frames: any[] = []

    const result: any = await chatReplyProcess({ message: PROMPT_PARTS, process: chat => frames.push(chat) })

    expect(mock).toHaveBeenCalledTimes(1)
    expect(result.data.notice).toBeUndefined()
    expect(frames.some(chat => chat.notice)).toBe(false)
  })

  it('纯文本请求 400：不重试（护栏：老格式行为与放宽前逐字一致）', async () => {
    const chatReplyProcess = await loadChatReplyProcess('100000')
    const { mock } = queuedFetch([{ status: 400 }])

    await expect(chatReplyProcess({ message: '你好' })).rejects.toMatchObject({
      status: 'Fail',
      message: expect.stringContaining('400'),
    })
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('纯文字分片数组（无图片）400：同样不重试 —— 降级只认图片，不认数组', async () => {
    const chatReplyProcess = await loadChatReplyProcess('100000')
    const { mock } = queuedFetch([{ status: 400 }])

    await expect(chatReplyProcess({ message: [{ type: 'text', text: '你好' }] })).rejects.toMatchObject({ status: 'Fail' })
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('带图但上游 401：鉴权问题与内容无关，不剥图重试', async () => {
    const chatReplyProcess = await loadChatReplyProcess('100000')
    const { mock } = queuedFetch([{ status: 401 }])

    await expect(chatReplyProcess({ message: PROMPT_PARTS })).rejects.toMatchObject({
      status: 'Fail',
      message: expect.stringContaining('Incorrect API key'),
    })
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('降级后写回 messageStore：下一轮的历史已是纯字符串，图片不会每轮重发', async () => {
    const chatReplyProcess = await loadChatReplyProcess('100000')
    const { requests } = queuedFetch([{ status: 400 }, { status: 200 }, { status: 200 }])

    const first: any = await chatReplyProcess({ message: PROMPT_PARTS })
    await chatReplyProcess({ message: '继续', lastContext: { parentMessageId: first.data.id } })

    const round2 = requests[2]
    expect(round2.messages.every((m: any) => typeof m.content === 'string')).toBe(true)
    expect(round2.messages.map((m: any) => m.content)).toContain('这张图里是什么')
  })
})

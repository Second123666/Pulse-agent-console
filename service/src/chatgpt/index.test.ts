import { afterEach, describe, expect, it, vi } from 'vitest'

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

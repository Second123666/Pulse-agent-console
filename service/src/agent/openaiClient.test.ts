import { ReadableStream } from 'node:stream/web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chatCompletionStream } from './openaiClient'

/** 构造一个逐块下发的 SSE 响应 */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks)
        controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

/** 组装一行 SSE data 帧 */
function sseLine(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** 组装一个带 delta 的 chunk 帧 */
function deltaFrame(delta: unknown, finishReason?: string): string {
  return sseLine({ choices: [{ delta, finish_reason: finishReason ?? null }] })
}

function stubFetch(chunks: string[]) {
  const fetchMock = vi.fn().mockResolvedValue(sseResponse(chunks))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  process.env.API_KEY = 'test-key'
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('chatCompletionStream', () => {
  it('文本增量：累积为完整 content，并逐片回调 onDelta', async () => {
    stubFetch([
      deltaFrame({ content: '你' }),
      deltaFrame({ content: '好' }),
      deltaFrame({}, 'stop'),
      'data: [DONE]\n\n',
    ])

    const deltas: string[] = []
    const result = await chatCompletionStream(
      { messages: [{ role: 'user', content: 'hi' }] },
      delta => deltas.push(delta),
    )

    expect(deltas).toEqual(['你', '好'])
    expect(result.content).toBe('你好')
    expect(result.finishReason).toBe('stop')
    expect(result.toolCalls).toEqual([])
  })

  it('tool_calls 分片累积：按 index 拼接 arguments，id 与 name 取自首片', async () => {
    stubFetch([
      deltaFrame({ tool_calls: [{ index: 0, id: 'call_a', function: { name: 'calculator', arguments: '{"exp' } }] }),
      // 后续分片只有 arguments，没有 id / name
      deltaFrame({ tool_calls: [{ index: 0, function: { arguments: 'ression":"1+1"}' } }] }),
      deltaFrame({}, 'tool_calls'),
    ])

    const result = await chatCompletionStream({ messages: [{ role: 'user', content: 'hi' }] })

    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].id).toBe('call_a')
    expect(result.toolCalls[0].function.name).toBe('calculator')
    // 关键：分片拼接后必须是合法 JSON，否则工具参数会残缺
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({ expression: '1+1' })
    expect(result.finishReason).toBe('tool_calls')
  })

  it('多个 tool_call 并行分片：按 index 各自累积，返回顺序按 index 稳定', async () => {
    stubFetch([
      deltaFrame({
        tool_calls: [
          { index: 1, id: 'call_b', function: { name: 'get_time', arguments: '{}' } },
          { index: 0, id: 'call_a', function: { name: 'calculator', arguments: '{"expr' } },
        ],
      }),
      deltaFrame({ tool_calls: [{ index: 0, function: { arguments: 'ession":"2*3"}' } }] }),
      deltaFrame({}, 'tool_calls'),
    ])

    const result = await chatCompletionStream({ messages: [{ role: 'user', content: 'hi' }] })

    expect(result.toolCalls.map(c => c.id)).toEqual(['call_a', 'call_b'])
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({ expression: '2*3' })
    expect(result.toolCalls[1].function.arguments).toBe('{}')
  })

  it('请求体带 stream:true 且透传 tools', async () => {
    const fetchMock = stubFetch([deltaFrame({}, 'stop')])

    await chatCompletionStream({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 't', description: 'd', parameters: {} } }],
      tool_choice: 'auto',
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.stream).toBe(true)
    expect(body.tool_choice).toBe('auto')
    expect(body.tools).toHaveLength(1)
  })

  it('跨块截断的帧仍能正确解析（半截 JSON 落在块边界）', async () => {
    // 同一个 data 帧被人为切成两半下发
    const whole = deltaFrame({ content: '完整内容' })
    const cut = Math.floor(whole.length / 2)
    stubFetch([whole.slice(0, cut), whole.slice(cut)])

    const deltas: string[] = []
    const result = await chatCompletionStream(
      { messages: [{ role: 'user', content: 'hi' }] },
      delta => deltas.push(delta),
    )

    expect(deltas).toEqual(['完整内容'])
    expect(result.content).toBe('完整内容')
  })

  it('HTTP 错误：抛出带状态码的 OpenAIError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"bad"}', { status: 401 })))

    await expect(chatCompletionStream({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects
      .toMatchObject({ name: 'OpenAIError', status: 401 })
  })

  it('调用方中止：原样抛出 AbortError，不伪装成超时错误', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      controller.abort()
      return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    }))

    await expect(
      chatCompletionStream({ messages: [{ role: 'user', content: 'hi' }], signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('内部超时：AbortError 被包装为超时的 OpenAIError', async () => {
    // 未传 signal，中止只能来自内部定时器 → 应包装为超时错误
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' })))

    await expect(chatCompletionStream({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects
      .toMatchObject({ name: 'OpenAIError', status: 0, message: 'Chat completions request timed out' })
  })
})

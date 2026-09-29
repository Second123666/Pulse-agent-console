import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runAgent } from './loop'
import type { ChatCompletionResult } from './openaiClient'
import type { AgentEvent, Tool } from './types'

const { mockChatCompletionStream } = vi.hoisted(() => ({ mockChatCompletionStream: vi.fn() }))

vi.mock('./openaiClient', () => ({
  chatCompletionStream: mockChatCompletionStream,
}))

function textResult(content: string): ChatCompletionResult {
  return { content, toolCalls: [], finishReason: 'stop' }
}

function toolCallsResult(calls: Array<{ name: string; args?: string }>): ChatCompletionResult {
  return {
    content: '我需要先调用工具确认一下。',
    toolCalls: calls.map((call, i) => ({
      id: `call_${i}`,
      type: 'function',
      function: { name: call.name, arguments: call.args ?? '{}' },
    })),
    finishReason: 'tool_calls',
  }
}

/**
 * 把 mock 结果包装成流式调用：content 作为增量经 onDelta 回调一次。
 * 真实实现会把 content 拆成多片，此处从简；分片累积逻辑由 openaiClient 自身保证。
 */
function asStream(result: ChatCompletionResult) {
  return (_options: unknown, onDelta?: (content: string) => void) => {
    if (result.content && onDelta)
      onDelta(result.content)
    return Promise.resolve(result)
  }
}

const timeTool: Tool = {
  name: 'get_time',
  description: '返回当前时间',
  parameters: {},
  handler: () => '2026-09-19 10:00:00',
}

beforeEach(() => {
  mockChatCompletionStream.mockReset()
})

describe('runAgent', () => {
  it('纯文本：一轮直接输出最终回答，且文本增量先于 answer 发出', async () => {
    mockChatCompletionStream.mockImplementationOnce(asStream(textResult('你好！')))
    const events: AgentEvent[] = []
    await runAgent({ messages: [{ role: 'user', content: '你好' }], onEvent: e => events.push(e) })

    expect(events.map(e => e.type)).toEqual(['text_delta', 'answer'])
    expect(events[0].type === 'text_delta' && events[0].content).toBe('你好！')
    expect(mockChatCompletionStream).toHaveBeenCalledTimes(1)
  })

  it('两轮工具调用：text_delta → thought → tool_call → tool_result → answer，且工具结果回填给模型', async () => {
    mockChatCompletionStream
      .mockImplementationOnce(asStream(toolCallsResult([{ name: 'get_time' }])))
      .mockImplementationOnce(asStream(textResult('现在是 2026-09-19 10:00:00')))
    const events: AgentEvent[] = []
    await runAgent({
      messages: [{ role: 'user', content: '现在几点？' }],
      tools: [timeTool],
      onEvent: e => events.push(e),
    })
    expect(events.map(e => e.type)).toEqual([
      'text_delta',
      'thought',
      'tool_call',
      'tool_result',
      'text_delta',
      'answer',
    ])

    const toolResult = events.find(e => e.type === 'tool_result')
    expect(toolResult?.type === 'tool_result' && toolResult.content).toBe('2026-09-19 10:00:00')

    // 第二次请求中应包含 role:'tool' 的工具结果消息
    const secondRequestMessages = mockChatCompletionStream.mock.calls[1][0].messages
    expect(secondRequestMessages.some((m: { role: string }) => m.role === 'tool')).toBe(true)
  })

  it('工具抛错：以错误文本回填（自愈），循环继续给出回答', async () => {
    const badTool: Tool = {
      name: 'boom',
      description: '总是失败',
      parameters: {},
      handler: () => { throw new Error('kaboom') },
    }
    mockChatCompletionStream
      .mockImplementationOnce(asStream(toolCallsResult([{ name: 'boom' }])))
      .mockImplementationOnce(asStream(textResult('工具出错了，但我会继续')))
    const events: AgentEvent[] = []
    await runAgent({ messages: [{ role: 'user', content: '触发工具' }], tools: [badTool], onEvent: e => events.push(e) })

    const toolResult = events.find(e => e.type === 'tool_result')
    expect(toolResult?.type === 'tool_result' && toolResult.content).toContain('[tool error]')
    expect(toolResult?.type === 'tool_result' && toolResult.content).toContain('kaboom')
    expect(events.at(-1)?.type).toBe('answer')
  })

  it('透传 signal 给 chatCompletionStream', async () => {
    mockChatCompletionStream.mockImplementationOnce(asStream(textResult('ok')))
    const controller = new AbortController()
    await runAgent({
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
      onEvent: () => {},
    })
    expect(mockChatCompletionStream.mock.calls[0][0].signal).toBe(controller.signal)
  })

  it('上游中止：AbortError 向上抛出而非转成 error 事件', async () => {
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' })
    mockChatCompletionStream.mockRejectedValueOnce(abortError)
    const events: AgentEvent[] = []
    await expect(
      runAgent({ messages: [{ role: 'user', content: 'hi' }], onEvent: e => events.push(e) }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    // 中止是正常路径，不应产生任何事件（尤其是 error）
    expect(events).toHaveLength(0)
  })

  it('步数熔断：注入熔断系统消息且仅一次，随后强制收尾', async () => {
    // 模型始终要求调工具，模拟死循环
    mockChatCompletionStream.mockImplementation(asStream(toolCallsResult([{ name: 'get_time' }])))
    const events: AgentEvent[] = []
    await runAgent({
      messages: [{ role: 'user', content: '一直调用工具' }],
      tools: [timeTool],
      maxSteps: 1,
      onEvent: e => events.push(e),
    })

    // 必然以 answer 收尾，且为强制截断回答
    const lastEvent = events.at(-1)
    expect(lastEvent?.type).toBe('answer')
    if (lastEvent?.type === 'answer')
      expect(lastEvent.content).toContain('截断')
    // 调用次数受控（初始 1 轮 + 熔断后 1 轮）
    expect(mockChatCompletionStream.mock.calls.length).toBeLessThanOrEqual(3)

    // 熔断系统消息只注入一次（messages 为共享引用，只检查最后一次请求）
    const lastMessages = mockChatCompletionStream.mock.calls.at(-1)![0].messages as Array<{ role: string; content: string }>
    const systemInjected = lastMessages.filter(m => m.role === 'system' && m.content.includes('上限'))
    expect(systemInjected).toHaveLength(1)
  })

  it('中文长文本触发预算熔断：CJK 按 1 字 ≈ 1 token 计（旧算法 /4 会漏触发）', async () => {
    // 200 个汉字：CJK 感知估算 ≈ 200 token > 预算 100（旧算法只有 50，不会触发）
    mockChatCompletionStream.mockImplementationOnce(asStream(textResult('好的，已收尾。（因预算/步数限制提前截断）')))
    const events: AgentEvent[] = []
    await runAgent({
      messages: [{ role: 'user', content: '汉'.repeat(200) }],
      tokenBudget: 100,
      onEvent: e => events.push(e),
    })

    // 首次请求就应注入熔断系统消息
    const firstMessages = mockChatCompletionStream.mock.calls[0][0].messages as Array<{ role: string; content: string }>
    expect(firstMessages.some(m => m.role === 'system' && m.content.includes('上限'))).toBe(true)
    expect(events.at(-1)?.type).toBe('answer')
  })

  it('熔断后模型仍要求工具：强制 tool_choice:none 再请求一次，回答为模型总结而非光秃截断提示', async () => {
    // 200 个汉字 + 预算 100 → 首轮即熔断；首轮模型仍要求调工具
    mockChatCompletionStream
      .mockImplementationOnce(asStream(toolCallsResult([{ name: 'get_time' }])))
      .mockImplementationOnce(asStream(textResult('总结：时间工具已返回结果。')))
    const events: AgentEvent[] = []
    await runAgent({
      messages: [{ role: 'user', content: '汉'.repeat(200) }],
      tools: [timeTool],
      tokenBudget: 100,
      onEvent: e => events.push(e),
    })

    // 工具确实执行过
    expect(events.some(e => e.type === 'tool_result')).toBe(true)
    // 强制收尾请求必须禁用工具
    expect(mockChatCompletionStream.mock.calls[1][0].tool_choice).toBe('none')
    // 最终回答来自模型的总结（含截断注明），而非光秃秃的截断提示
    const lastEvent = events.at(-1)
    expect(lastEvent?.type).toBe('answer')
    if (lastEvent?.type === 'answer') {
      expect(lastEvent.content).toContain('总结：时间工具已返回结果')
      expect(lastEvent.content).toContain('提前截断')
    }
  })
})

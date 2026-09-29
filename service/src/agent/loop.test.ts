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
})

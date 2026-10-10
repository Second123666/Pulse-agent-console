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

  it('超大工具结果被截断，且 SSE 事件与回填上下文用的是同一份截断文本', async () => {
    const huge = 'A'.repeat(20000)
    const hugeTool: Tool = {
      name: 'read_huge',
      description: '返回超长内容',
      parameters: {},
      handler: () => huge,
    }
    mockChatCompletionStream
      .mockImplementationOnce(asStream(toolCallsResult([{ name: 'read_huge' }])))
      .mockImplementationOnce(asStream(textResult('已读完')))

    const events: AgentEvent[] = []
    await runAgent({
      messages: [{ role: 'user', content: '读文件' }],
      tools: [hugeTool],
      onEvent: e => events.push(e),
    })

    const toolResult = events.find(e => e.type === 'tool_result')
    const content = toolResult?.type === 'tool_result' ? toolResult.content : ''
    expect(content.length).toBeLessThan(huge.length)
    expect(content).toContain('[已截断：原 20000 字符]')
    // 截断保留的是前缀
    expect(content.startsWith('A'.repeat(100))).toBe(true)

    // 回填给模型的 tool 消息与事件内容完全一致（单点截断，不存在两套阈值）
    const secondRequestMessages = mockChatCompletionStream.mock.calls[1][0].messages
    const toolMessage = secondRequestMessages.find((m: { role: string }) => m.role === 'tool')
    expect(toolMessage.content).toBe(content)
  })

  it('未超阈值的工具结果原样回填，不加截断标记', async () => {
    mockChatCompletionStream
      .mockImplementationOnce(asStream(toolCallsResult([{ name: 'get_time' }])))
      .mockImplementationOnce(asStream(textResult('好')))

    const events: AgentEvent[] = []
    await runAgent({
      messages: [{ role: 'user', content: '现在几点？' }],
      tools: [timeTool],
      onEvent: e => events.push(e),
    })

    const toolResult = events.find(e => e.type === 'tool_result')
    expect(toolResult?.type === 'tool_result' && toolResult.content).toBe('2026-09-19 10:00:00')
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

  /** 按类型收窄事件数组，便于取 name / content 断言 */
  function ofType<T extends AgentEvent['type']>(events: AgentEvent[], type: T) {
    return events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type)
  }

  /** 延迟指定毫秒后返回的工具，用于验证并发与事件顺序 */
  function sleepTool(name: string, ms: number, output?: string): Tool {
    return {
      name,
      description: '延迟后返回',
      parameters: {},
      handler: () => new Promise<string>(resolve => setTimeout(() => resolve(output ?? `${name} 完成`), ms)),
    }
  }

  it('并发执行：tool_result 按原顺序发出（非完成顺序），且全部 tool_call 先于任何 tool_result', async () => {
    // 故意让完成顺序与调用顺序相反：t3 最快、t1 最慢。
    // 若实现改为按完成顺序推送，下面的断言会失败
    mockChatCompletionStream
      .mockImplementationOnce(asStream(toolCallsResult([{ name: 't1' }, { name: 't2' }, { name: 't3' }])))
      .mockImplementationOnce(asStream(textResult('三个工具都完成了')))

    const events: AgentEvent[] = []
    await runAgent({
      messages: [{ role: 'user', content: '跑三个工具' }],
      tools: [sleepTool('t1', 60), sleepTool('t2', 30), sleepTool('t3', 0)],
      onEvent: e => events.push(e),
    })

    expect(ofType(events, 'tool_call').map(e => e.name)).toEqual(['t1', 't2', 't3'])
    expect(ofType(events, 'tool_result').map(e => e.name)).toEqual(['t1', 't2', 't3'])
    // 结果内容与各自工具对应，证明没有错配
    expect(ofType(events, 'tool_result').map(e => e.content)).toEqual(['t1 完成', 't2 完成', 't3 完成'])

    // 全部 tool_call 先发：最后一个 tool_call 必须早于第一个 tool_result
    const types = events.map(e => e.type)
    expect(types.lastIndexOf('tool_call')).toBeLessThan(types.indexOf('tool_result'))

    // 回填给模型的 tool 消息顺序与 tool_call_id 一一对应
    const toolMessages = mockChatCompletionStream.mock.calls[1][0].messages
      .filter((m: { role: string }) => m.role === 'tool')
    expect(toolMessages.map((m: { tool_call_id: string }) => m.tool_call_id))
      .toEqual(['call_0', 'call_1', 'call_2'])
  })

  it('并发执行：单个工具失败不影响其他，失败项按自愈策略回填错误文本', async () => {
    const okTool = (name: string, output: string): Tool => ({
      name,
      description: '总是成功',
      parameters: {},
      handler: () => output,
    })
    const badTool: Tool = {
      name: 'boom',
      description: '总是失败',
      parameters: {},
      handler: () => { throw new Error('kaboom') },
    }
    mockChatCompletionStream
      .mockImplementationOnce(asStream(toolCallsResult([{ name: 'ok1' }, { name: 'boom' }, { name: 'ok2' }])))
      .mockImplementationOnce(asStream(textResult('两个成功一个失败')))

    const events: AgentEvent[] = []
    await runAgent({
      messages: [{ role: 'user', content: '触发' }],
      tools: [okTool('ok1', '甲'), badTool, okTool('ok2', '乙')],
      onEvent: e => events.push(e),
    })

    const results = ofType(events, 'tool_result')
    expect(results.map(r => r.name)).toEqual(['ok1', 'boom', 'ok2'])
    expect(results[0].content).toBe('甲')
    expect(results[1].content).toContain('[tool error]')
    expect(results[1].content).toContain('kaboom')
    expect(results[2].content).toBe('乙')
    // 失败不阻断循环，仍以 answer 收尾
    expect(events.at(-1)?.type).toBe('answer')
  })

  it('并发执行：3 个工具的总耗时接近最慢的一个，而非三者之和', async () => {
    mockChatCompletionStream
      .mockImplementationOnce(asStream(toolCallsResult([{ name: 's1' }, { name: 's2' }, { name: 's3' }])))
      .mockImplementationOnce(asStream(textResult('完成')))

    const startedAt = Date.now()
    await runAgent({
      messages: [{ role: 'user', content: '跑三个慢工具' }],
      tools: [sleepTool('s1', 120), sleepTool('s2', 120), sleepTool('s3', 120)],
      onEvent: () => {},
    })
    const elapsed = Date.now() - startedAt

    // 串行下限 360ms，并发约 120ms；阈值取 250ms 使两侧都留有余量（CI 抖动）
    expect(elapsed).toBeLessThan(250)
  })

  /** 需用户审批的工具 */
  function gatedTool(name: string, output: string, reason = '需要确认'): Tool {
    return {
      name,
      description: '需审批的工具',
      parameters: {},
      requiresApproval: true,
      approvalReason: reason,
      handler: () => output,
    }
  }

  it('需审批工具：批准后正常执行，审批事件先于结果且带出名称/参数/理由', async () => {
    mockChatCompletionStream
      .mockImplementationOnce(asStream(toolCallsResult([{ name: 'gated', args: '{"q":"x"}' }])))
      .mockImplementationOnce(asStream(textResult('已执行')))
    const events: AgentEvent[] = []
    const seenRequests: Array<{ name: string; reason: string }> = []

    await runAgent({
      messages: [{ role: 'user', content: '跑' }],
      tools: [gatedTool('gated', '结果甲')],
      onEvent: e => events.push(e),
      requestApproval: async (req) => {
        seenRequests.push(req)
        return true
      },
    })

    const requests = ofType(events, 'tool_approval_request')
    expect(requests).toHaveLength(1)
    expect(requests[0].name).toBe('gated')
    expect(requests[0].arguments).toBe('{"q":"x"}')
    expect(requests[0].reason).toBe('需要确认')
    expect(seenRequests).toHaveLength(1)

    // 审批事件必须先于该工具的结果
    const types = events.map(e => e.type)
    expect(types.indexOf('tool_approval_request')).toBeLessThan(types.indexOf('tool_result'))
    expect(ofType(events, 'tool_result')[0].content).toBe('结果甲')
  })

  it('需审批工具：拒绝时工具不执行，回填 [tool error] 用户未批准执行，循环仍能自愈收尾', async () => {
    let executed = false
    const tool: Tool = {
      name: 'gated',
      description: '需审批',
      parameters: {},
      requiresApproval: true,
      handler: () => {
        executed = true
        return '不该出现'
      },
    }
    mockChatCompletionStream
      .mockImplementationOnce(asStream(toolCallsResult([{ name: 'gated' }])))
      .mockImplementationOnce(asStream(textResult('那我换个方式回答')))
    const events: AgentEvent[] = []

    await runAgent({
      messages: [{ role: 'user', content: '跑' }],
      tools: [tool],
      onEvent: e => events.push(e),
      requestApproval: async () => false,
    })

    expect(executed).toBe(false)
    expect(ofType(events, 'tool_result')[0].content).toBe('[tool error] 用户未批准执行')
    // 拒绝不阻断循环，模型据错误文本自愈后仍给出回答
    expect(events.at(-1)?.type).toBe('answer')
  })

  it('需审批工具：未接线审批通道时 fail-closed 拒绝（不默认放行）', async () => {
    let executed = false
    const tool: Tool = {
      name: 'gated',
      description: '需审批',
      parameters: {},
      requiresApproval: true,
      handler: () => {
        executed = true
        return '不该出现'
      },
    }
    mockChatCompletionStream
      .mockImplementationOnce(asStream(toolCallsResult([{ name: 'gated' }])))
      .mockImplementationOnce(asStream(textResult('好的')))
    const events: AgentEvent[] = []

    // 刻意不传 requestApproval
    await runAgent({
      messages: [{ role: 'user', content: '跑' }],
      tools: [tool],
      onEvent: e => events.push(e),
    })

    expect(executed).toBe(false)
    expect(ofType(events, 'tool_result')[0].content).toContain('用户未批准执行')
  })

  it('并发 + 审批：同轮两个需审批工具各自独立决策，拒绝一个不影响另一个', async () => {
    mockChatCompletionStream
      .mockImplementationOnce(asStream(toolCallsResult([{ name: 'a' }, { name: 'b' }])))
      .mockImplementationOnce(asStream(textResult('完成')))
    const events: AgentEvent[] = []

    await runAgent({
      messages: [{ role: 'user', content: '跑' }],
      tools: [gatedTool('a', '甲'), gatedTool('b', '乙')],
      onEvent: e => events.push(e),
      // 只批准 a
      requestApproval: async req => req.name === 'a',
    })

    expect(ofType(events, 'tool_approval_request').map(e => e.name)).toEqual(['a', 'b'])
    const results = ofType(events, 'tool_result')
    expect(results.map(r => r.name)).toEqual(['a', 'b'])
    expect(results[0].content).toBe('甲')
    expect(results[1].content).toContain('用户未批准执行')
  })

  it('无需审批的工具不触发审批事件（既有工具行为不变）', async () => {
    mockChatCompletionStream
      .mockImplementationOnce(asStream(toolCallsResult([{ name: 'get_time' }])))
      .mockImplementationOnce(asStream(textResult('好')))
    const events: AgentEvent[] = []
    const requestApproval = vi.fn(async () => true)

    await runAgent({
      messages: [{ role: 'user', content: '几点' }],
      tools: [timeTool],
      onEvent: e => events.push(e),
      requestApproval,
    })

    expect(ofType(events, 'tool_approval_request')).toHaveLength(0)
    expect(requestApproval).not.toHaveBeenCalled()
  })
})

describe('用量统计（9.4）', () => {
  /** 给 mock 结果挂上上游 usage */
  function withUsage(result: ChatCompletionResult, promptTokens: number, completionTokens: number): ChatCompletionResult {
    return { ...result, usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens } }
  }

  it('answer 事件带出累计用量与逐轮明细', async () => {
    mockChatCompletionStream
      .mockImplementationOnce(asStream(withUsage(toolCallsResult([{ name: 'get_time' }]), 100, 20)))
      .mockImplementationOnce(asStream(withUsage(textResult('现在 10 点'), 150, 30)))

    const events: AgentEvent[] = []
    await runAgent({
      messages: [{ role: 'user', content: '几点' }],
      tools: [timeTool],
      onEvent: e => events.push(e),
    })

    const answer = events.at(-1)
    expect(answer?.type).toBe('answer')
    const usage = answer?.type === 'answer' ? answer.usage : undefined
    expect(usage).toBeDefined()
    // 两轮模型调用：100+150 / 20+30
    expect(usage?.promptTokens).toBe(250)
    expect(usage?.completionTokens).toBe(50)
    expect(usage?.totalTokens).toBe(300)
    expect(usage?.steps).toHaveLength(2)
    expect(usage?.steps.map(s => s.turn)).toEqual([0, 1])
    expect(usage?.steps[0]).toMatchObject({ promptTokens: 100, completionTokens: 20 })
    expect(usage?.steps[1]).toMatchObject({ promptTokens: 150, completionTokens: 30 })
    // 耗时是墙钟时间，只断言非负
    expect(usage?.durationMs).toBeGreaterThanOrEqual(0)
    expect(usage?.steps.every(s => s.durationMs >= 0)).toBe(true)
  })

  it('上游不给 usage 时 token 计 0，但仍带出 steps 与耗时（统计降级而非整个缺失）', async () => {
    mockChatCompletionStream.mockImplementationOnce(asStream(textResult('你好')))

    const events: AgentEvent[] = []
    await runAgent({ messages: [{ role: 'user', content: '你好' }], onEvent: e => events.push(e) })

    const answer = events.at(-1)
    const usage = answer?.type === 'answer' ? answer.usage : undefined
    expect(usage).toMatchObject({ promptTokens: 0, completionTokens: 0, totalTokens: 0 })
    expect(usage?.steps).toHaveLength(1)
    expect(usage?.steps[0]).toMatchObject({ promptTokens: 0, completionTokens: 0 })
  })

  it('纯文本一轮也带 usage（不依赖是否调用过工具）', async () => {
    mockChatCompletionStream.mockImplementationOnce(asStream(withUsage(textResult('你好'), 12, 7)))

    const events: AgentEvent[] = []
    await runAgent({ messages: [{ role: 'user', content: '你好' }], onEvent: e => events.push(e) })

    const answer = events.at(-1)
    const usage = answer?.type === 'answer' ? answer.usage : undefined
    expect(usage?.totalTokens).toBe(19)
    expect(usage?.steps).toHaveLength(1)
  })
})

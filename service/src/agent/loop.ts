import { agentConfig } from '../utils/config'
import { APPROVAL_DENIED_MESSAGE } from './approvals'
import type { ChatCompletionResult, OpenAIMessage, OpenAITool, OpenAIToolChoice } from './openaiClient'
import { chatCompletionStream } from './openaiClient'
import type { AgentRunOptions, AgentUsage, AgentUsageStep } from './types'

/** 熔断提示词：要求模型立刻总结收尾（仅注入一次） */
const BREAKER_PROMPT = '你已达到最大步数或 Token 预算上限。请立即给出最终总结回答并收尾，不要再次调用任何工具。在回答末尾注明「（因预算/步数限制提前截断）」。'

/** token 估算系数：CJK 字符（中日韩）约 1 字符 ≈ 1 token，可按实测调整 */
const CJK_TOKEN_RATIO = 1
/** token 估算系数：非 CJK 字符约 4 字符 ≈ 1 token */
const NON_CJK_TOKEN_RATIO = 1 / 4

/** 粗略判断 CJK 字符（CJK 统一表意 + 日文假名 + 谚文） */
function isCjk(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return (
    (code >= 0x4E00 && code <= 0x9FFF)
    || (code >= 0x3040 && code <= 0x30FF)
    || (code >= 0xAC00 && code <= 0xD7AF)
  )
}

/**
 * 工具结果截断：**单点收口**，避免各工具各截一套（阈值见 `AGENT_TOOL_RESULT_MAX_CHARS`）。
 *
 * 管的是「喂给模型的上下文」而非 UI 展示（前端的展示截断是另一回事、阈值更小）。
 * 一个 100KB 的 read_file 结果足以吃光整个 token 预算，必须有上限。
 */
function truncateToolResult(content: string): string {
  const limit = agentConfig.agentToolResultMaxChars
  if (!Number.isFinite(limit) || limit <= 0 || content.length <= limit)
    return content
  return `${content.slice(0, limit)}\n[已截断：原 ${content.length} 字符]`
}

/** ReAct 主循环：调模型 → 有 tool_calls 则执行并回填 → 否则输出最终回答 */
export async function runAgent(options: AgentRunOptions): Promise<void> {
  const maxSteps = Math.max(1, options.maxSteps ?? agentConfig.agentMaxSteps)
  const tokenBudget = options.tokenBudget ?? agentConfig.agentTokenBudget
  const toolMap = new Map((options.tools ?? []).map(tool => [tool.name, tool]))
  const openAITools: OpenAITool[] = (options.tools ?? []).map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))

  const messages: OpenAIMessage[] = []
  if (options.systemMessage)
    messages.push({ role: 'system', content: options.systemMessage })
  for (const m of options.messages)
    messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })

  // 粗略 token 估算：CJK 按字计、其余按字符数 /4 计，用于预算熔断
  // （原版统一 /4 会把中文低估约 4 倍，长中文对话永远触发不了预算熔断）
  const estimateTokens = (): number =>
    messages.reduce(
      (sum, m) => {
        const text = (m.content ?? '') + (m.tool_calls ? JSON.stringify(m.tool_calls) : '')
        let cjk = 0
        for (const char of text) {
          if (isCjk(char))
            cjk++
        }
        return sum + cjk * CJK_TOKEN_RATIO + (text.length - cjk) * NON_CJK_TOKEN_RATIO
      },
      0,
    )

  let stepCount = 0
  let circuitBroken = false

  // 用量统计：逐轮累计 token 与耗时，随 answer 事件带出（见 AgentUsage）。
  // 上游不给 usage 时 token 计 0，耗时仍照记 —— 统计缺数字好过统计整个缺失
  const startedAt = Date.now()
  const usageSteps: AgentUsageStep[] = []
  let promptTokens = 0
  let completionTokens = 0

  const buildUsage = (): AgentUsage => ({
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    durationMs: Date.now() - startedAt,
    steps: usageSteps,
  })

  /** 统一的模型调用入口：把「本轮耗时与用量」的记账收在一处，避免各调用点各记一套 */
  const callModel = async (toolChoice: OpenAIToolChoice): Promise<ChatCompletionResult> => {
    const turnStartedAt = Date.now()
    const result = await chatCompletionStream(
      { messages, tools: openAITools, tool_choice: toolChoice, signal: options.signal },
      delta => options.onEvent({ type: 'text_delta', content: delta }),
    )
    const stepPrompt = result.usage?.promptTokens ?? 0
    const stepCompletion = result.usage?.completionTokens ?? 0
    usageSteps.push({
      turn: usageSteps.length,
      promptTokens: stepPrompt,
      completionTokens: stepCompletion,
      durationMs: Date.now() - turnStartedAt,
    })
    promptTokens += stepPrompt
    completionTokens += stepCompletion
    return result
  }

  while (stepCount < maxSteps + 1) {
    // 熔断：步数用尽或 token 预算超限，注入系统消息要求模型总结收尾（仅一次）
    if (!circuitBroken && (stepCount >= maxSteps || estimateTokens() > tokenBudget)) {
      messages.push({ role: 'system', content: BREAKER_PROMPT })
      circuitBroken = true
    }

    // 流式调用：文本增量实时转发给前端，定稿仍走下方的 thought / answer 事件
    const result = await callModel('auto')

    // 无工具调用 → 直接给出最终回答；若已熔断且模型未注明截断，兜底追加说明
    if (result.toolCalls.length === 0) {
      let content = result.content ?? ''
      if (circuitBroken && !content.includes('提前截断'))
        content = `${content}\n\n（因预算/步数限制提前截断）`
      options.onEvent({ type: 'answer', content, usage: buildUsage() })
      return
    }

    // 有工具调用：先发 thought（模型在调用工具前的思考文本）
    if (result.content)
      options.onEvent({ type: 'thought', content: result.content })

    messages.push({ role: 'assistant', content: result.content, tool_calls: result.toolCalls })

    // 本轮工具先按原顺序全部宣告（前端据此立刻渲染出全部工具卡片），随后并发执行 ——
    // 模型一次返回多个独立调用时不再串行等待。当前工具集全部只读/幂等，可安全并发
    for (const call of result.toolCalls)
      options.onEvent({ type: 'tool_call', id: call.id, name: call.function.name, arguments: call.function.arguments })

    // allSettled：单个工具失败不影响其他（按自愈策略回填错误文本），
    // 且结果数组顺序与 toolCalls **严格一致**（role:'tool' 靠 tool_call_id 对应，乱序会让模型困惑）
    const settled = await Promise.allSettled(result.toolCalls.map(async (call) => {
      const tool = toolMap.get(call.function.name)
      if (!tool)
        throw new Error(`Unknown tool: ${call.function.name}`)
      const args = JSON.parse(call.function.arguments || '{}')

      // 需审批的工具：先推审批事件，再挂起等待用户决策。
      // 未接线审批通道时一律拒绝（fail-closed，不默认放行）；
      // 拒绝与超时都落到下方 catch，按既有自愈策略回填 [tool error]，模型可据此改道
      if (tool.requiresApproval) {
        const reason = tool.approvalReason ?? '该工具需要确认后才会执行'
        options.onEvent({ type: 'tool_approval_request', id: call.id, name: call.function.name, arguments: call.function.arguments, reason })
        const approved = options.requestApproval
          ? await options.requestApproval({ id: call.id, name: call.function.name, arguments: call.function.arguments, reason })
          : false
        if (!approved)
          throw new Error(APPROVAL_DENIED_MESSAGE)
      }

      // 单点截断：回填模型上下文与 SSE 事件用同一份截断结果，
      // 保证「模型看到的」与「前端收到的」一致（前端另有更小阈值的展示截断）
      return truncateToolResult(String(await tool.handler(args)))
    }))

    // 结果按**原顺序**推送，而非完成顺序：前端 agentSteps 是「按到达顺序 append 的扁平数组」
    // （ToolCallCard.vue 直接 v-for 渲染），且会落盘回放 —— 完成顺序会让「工具」与「结果」
    // 永久错位、历史会话无法正确回放，同时让测试与回放不可复现
    result.toolCalls.forEach((call, index) => {
      const outcome = settled[index]
      const content = outcome.status === 'fulfilled'
        ? outcome.value
        : `[tool error] ${outcome.reason?.message ?? String(outcome.reason)}`
      options.onEvent({ type: 'tool_result', id: call.id, name: call.function.name, content })
      messages.push({ role: 'tool', tool_call_id: call.id, content })
    })

    stepCount++

    // 熔断已注入且模型仍要求工具 → 再发一次请求并禁用工具，强制模型输出文本总结（防死循环）；
    // 若强制请求失败或模型仍返回工具调用，退回光秃截断提示，保证必有 answer 事件
    if (circuitBroken) {
      let content = ''
      try {
        const final = await callModel('none')
        if (final.toolCalls.length === 0 && final.content)
          content = final.content
      }
      catch {
        // 忽略，走下方兜底文案
      }
      if (!content.includes('提前截断'))
        content = content ? `${content}\n\n（因预算/步数限制提前截断）` : '（因预算/步数限制提前截断）'
      options.onEvent({ type: 'answer', content, usage: buildUsage() })
      return
    }
  }

  // 理论不可达（while 上限兜底）
  options.onEvent({ type: 'error', message: 'Agent loop terminated unexpectedly' })
}

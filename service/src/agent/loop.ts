import { agentConfig } from '../utils/config'
import { type OpenAIMessage, type OpenAITool, chatCompletionStream } from './openaiClient'
import type { AgentRunOptions } from './types'

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
    (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0x3040 && code <= 0x30ff)
    || (code >= 0xac00 && code <= 0xd7af)
  )
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

  while (stepCount < maxSteps + 1) {
    // 熔断：步数用尽或 token 预算超限，注入系统消息要求模型总结收尾（仅一次）
    if (!circuitBroken && (stepCount >= maxSteps || estimateTokens() > tokenBudget)) {
      messages.push({ role: 'system', content: BREAKER_PROMPT })
      circuitBroken = true
    }

    // 流式调用：文本增量实时转发给前端，定稿仍走下方的 thought / answer 事件
    const result = await chatCompletionStream(
      {
        messages,
        tools: openAITools,
        tool_choice: 'auto',
        signal: options.signal,
      },
      delta => options.onEvent({ type: 'text_delta', content: delta }),
    )

    // 无工具调用 → 直接给出最终回答；若已熔断且模型未注明截断，兜底追加说明
    if (result.toolCalls.length === 0) {
      let content = result.content ?? ''
      if (circuitBroken && !content.includes('提前截断'))
        content = `${content}\n\n（因预算/步数限制提前截断）`
      options.onEvent({ type: 'answer', content })
      return
    }

    // 有工具调用：先发 thought（模型在调用工具前的思考文本）
    if (result.content)
      options.onEvent({ type: 'thought', content: result.content })

    messages.push({ role: 'assistant', content: result.content, tool_calls: result.toolCalls })

    for (const call of result.toolCalls) {
      options.onEvent({ type: 'tool_call', id: call.id, name: call.function.name, arguments: call.function.arguments })
      let content: string
      try {
        const tool = toolMap.get(call.function.name)
        if (!tool)
          throw new Error(`Unknown tool: ${call.function.name}`)
        const args = JSON.parse(call.function.arguments || '{}')
        content = String(await tool.handler(args))
      }
      catch (error: any) {
        // 工具异常以错误文本回填，模型可基于该信息自愈
        content = `[tool error] ${error?.message ?? String(error)}`
      }
      options.onEvent({ type: 'tool_result', id: call.id, name: call.function.name, content })
      messages.push({ role: 'tool', tool_call_id: call.id, content })
    }

    stepCount++

    // 熔断已注入且模型仍要求工具 → 再发一次请求并禁用工具，强制模型输出文本总结（防死循环）；
    // 若强制请求失败或模型仍返回工具调用，退回光秃截断提示，保证必有 answer 事件
    if (circuitBroken) {
      let content = ''
      try {
        const final = await chatCompletionStream(
          { messages, tools: openAITools, tool_choice: 'none', signal: options.signal },
          delta => options.onEvent({ type: 'text_delta', content: delta }),
        )
        if (final.toolCalls.length === 0 && final.content)
          content = final.content
      }
      catch {
        // 忽略，走下方兜底文案
      }
      if (!content.includes('提前截断'))
        content = content ? `${content}\n\n（因预算/步数限制提前截断）` : '（因预算/步数限制提前截断）'
      options.onEvent({ type: 'answer', content })
      return
    }
  }

  // 理论不可达（while 上限兜底）
  options.onEvent({ type: 'error', message: 'Agent loop terminated unexpectedly' })
}

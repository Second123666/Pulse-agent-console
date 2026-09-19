import { agentConfig } from '../utils/config'
import { type OpenAIMessage, type OpenAITool, chatCompletion } from './openaiClient'
import type { AgentRunOptions } from './types'

/** 熔断提示词：要求模型立刻总结收尾（仅注入一次） */
const BREAKER_PROMPT = '你已达到最大步数或 Token 预算上限。请立即给出最终总结回答并收尾，不要再次调用任何工具。在回答末尾注明「（因预算/步数限制提前截断）」。'

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

  // 粗略 token 估算：按字符数 /4 计，用于预算熔断
  const estimateTokens = (): number =>
    messages.reduce(
      (sum, m) => sum + ((m.content?.length ?? 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0)) / 4,
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

    const result = await chatCompletion({
      messages,
      tools: openAITools,
      tool_choice: 'auto',
    })

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

    // 熔断已注入且模型仍要求工具 → 强制收尾，防止死循环
    if (circuitBroken) {
      options.onEvent({ type: 'answer', content: '（因预算/步数限制提前截断）' })
      return
    }
  }

  // 理论不可达（while 上限兜底）
  options.onEvent({ type: 'error', message: 'Agent loop terminated unexpectedly' })
}

import type { OpenAITool } from './openaiClient'
import type { Tool } from './types'

/** 工具注册表：以 name 为键的全局 Map */
const tools = new Map<string, Tool>()

export function register(tool: Tool): void {
  tools.set(tool.name, tool)
}

export function list(): Tool[] {
  return [...tools.values()]
}

export function get(name: string): Tool | undefined {
  return tools.get(name)
}

/** 转换为 OpenAI tools 请求参数格式 */
export function toOpenAITools(): OpenAITool[] {
  return list().map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
}

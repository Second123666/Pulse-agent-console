import * as dotenv from 'dotenv'
import { isNotEmptyString } from './is'

dotenv.config()

export interface AgentConfig {
  openaiApiBaseUrl: string
  openaiApiModel: string
  agentMaxSteps: number
  agentTokenBudget: number
  embeddingModel: string
}

function envNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

function envString(name: string, fallback = ''): string {
  const raw = process.env[name]?.trim()
  return isNotEmptyString(raw) ? raw : fallback
}

/** Agent 模式统一配置，读取自 .env，缺失时使用默认值 */
export const agentConfig: AgentConfig = {
  openaiApiBaseUrl: envString('OPENAI_API_BASE_URL'),
  openaiApiModel: envString('OPENAI_API_MODEL'),
  agentMaxSteps: envNumber('AGENT_MAX_STEPS', 10),
  agentTokenBudget: envNumber('AGENT_TOKEN_BUDGET', 30000),
  embeddingModel: envString('EMBEDDING_MODEL'),
}

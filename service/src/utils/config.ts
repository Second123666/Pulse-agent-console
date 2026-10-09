import * as dotenv from 'dotenv'
import { isNotEmptyString } from './is'

dotenv.config()

export interface AgentConfig {
  openaiApiBaseUrl: string
  openaiApiModel: string
  agentMaxSteps: number
  agentTokenBudget: number
  /** 单个工具结果回填模型上下文前的字符上限（超出即截断，见 agent/loop.ts） */
  agentToolResultMaxChars: number
  embeddingModel: string
}

export interface AuthConfig {
  /** JWT 签名密钥；未配置时由 auth/secret.ts 生成进程内临时密钥并告警 */
  jwtSecret: string
  /** 登录态有效期（秒） */
  tokenTtlSeconds: number
  /** 可选的注册邀请码（沿用原 AUTH_SECRET_KEY 变量名）：配置后注册必须携带 */
  inviteCode: string
}

function envNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return (Number.isFinite(raw) && raw > 0) ? raw : fallback
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
  agentToolResultMaxChars: envNumber('AGENT_TOOL_RESULT_MAX_CHARS', 8000),
  embeddingModel: envString('EMBEDDING_MODEL'),
}

/** 登录态默认有效期：7 天 */
const DEFAULT_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60

/** 鉴权配置（见 .env.example 说明） */
export const authConfig: AuthConfig = {
  jwtSecret: envString('JWT_SECRET'),
  tokenTtlSeconds: envNumber('AUTH_TOKEN_TTL', DEFAULT_TOKEN_TTL_SECONDS),
  inviteCode: envString('AUTH_SECRET_KEY'),
}

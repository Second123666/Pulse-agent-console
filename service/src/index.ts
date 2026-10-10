import { randomUUID } from 'node:crypto'
import express from 'express'
import type { RequestProps } from './types'
import type { ChatMessage } from './chatgpt'
import { chatConfig, chatReplyProcess, currentModel } from './chatgpt'

import { limiter } from './middleware/limiter'
import { requireAuth } from './middleware/auth'
import { authRouter } from './auth/routes'
import { conversationRouter } from './conversation/routes'
import { usageRouter } from './usage/routes'
import { recordUsage } from './usage/store'
import { getJwtSecret } from './auth/secret'
import { getDb } from './store/db'
import { authConfig } from './utils/config'
import { runAgent } from './agent/loop'
import { awaitApproval, clearRunApprovals, resolveApproval } from './agent/approvals'
import { list } from './agent/registry'
import type { AgentEvent, AgentUsage } from './agent/types'
import { composeSystemMessage, recallMemories, rememberConversation } from './memory'
import './tools'
import { loadMcpTools } from './mcp'

const app = express()
const router = express.Router()

app.use(express.static('public'))
// 会话全量保存携带完整聊天记录（含 agentSteps），远超 express.json 默认的 100kb；
// 规模上限在 conversation/routes.ts 里按条数校验，这里只放宽字节限制
app.use(express.json({ limit: '10mb' }))

app.all('*', (_, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Headers', 'authorization, Content-Type')
  res.header('Access-Control-Allow-Methods', '*')
  next()
})

// 需登录：否则任何人可 curl 消耗服务端 API key 与额度（requireAuth 见 middleware/auth.ts）
// SSE：text/event-stream + data: 帧，前端用 fetch ReadableStream 逐帧解析（协议与 /agent-process 统一）
router.post('/chat-process', [limiter, requireAuth], async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()

  // 客户端断开（用户点停止 / 关页面）时中止上游请求，避免继续消耗 token（与 /agent-process 一致）
  const controller = new AbortController()
  res.on('close', () => {
    // writableEnded 为 false 说明是客户端提前断开，而非本轮正常结束
    if (!res.writableEnded)
      controller.abort()
  })

  const writeEvent = (chat: ChatMessage) => {
    res.write(`data: ${JSON.stringify(chat)}\n\n`)
  }

  // SSE 保活：模型思考期间连接空闲可能被中间层掐断（与 /agent-process 一致）
  // 注释帧（':' 开头）不是 data: 行，前端解析器天然忽略
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000)

  try {
    const { prompt, options = {}, systemMessage, temperature, top_p } = req.body as RequestProps
    await chatReplyProcess({
      message: prompt,
      lastContext: options,
      signal: controller.signal,
      process: writeEvent,
      systemMessage,
      temperature,
      top_p,
    })
  }
  catch (error: any) {
    // 客户端主动中止属正常路径，不当作错误上报（连接已断，写了也没人收）
    // chatReplyProcess 在客户端中止时原样上抛 AbortError，此处据 name 静默
    if (error?.name !== 'AbortError') {
      const message = error?.message ?? 'Please check the back-end console'
      res.write(`data: ${JSON.stringify({ status: 'Fail', message })}\n\n`)
    }
  }
  finally {
    clearInterval(heartbeat)
    res.end()
  }
})

router.post('/agent-process', [limiter, requireAuth], async (req, res) => {
  // 本次运行的标识：前端凭它调 /agent-approve 回传审批决策（必须在 flushHeaders 之前设置）
  const runId = randomUUID()

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  // 自定义响应头默认不对跨源 JS 暴露；走 vite 代理时同源本无此问题，此处是额外保险
  res.setHeader('Access-Control-Expose-Headers', 'X-Agent-Run-Id')
  res.setHeader('X-Agent-Run-Id', runId)
  res.flushHeaders?.()

  const { prompt, systemMessage, messages, conversationId } = req.body as RequestProps
  const userId = Number(req.user?.sub)
  const hasUser = Number.isInteger(userId) && userId > 0
  const writeEvent = (event: AgentEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  // 客户端断开（用户点停止 / 关页面）时中止循环，避免后端继续跑完并消耗 token
  const controller = new AbortController()
  res.on('close', () => {
    // writableEnded 为 false 说明是客户端提前断开，而非本轮正常结束
    if (!res.writableEnded) {
      controller.abort()
      globalThis.console.log('[agent] 客户端断开，已中止 Agent 循环')
    }
  })

  // SSE 保活：长工具调用期间连接空闲可能被中间层掐断
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000)

  try {
    // 历史上下文（缺省为空数组，此时行为与单轮对话完全一致）
    const history = Array.isArray(messages) ? messages : []

    // 长期记忆召回：按本轮提问做语义检索，把相关历史摘要拼进 system message。
    // 召回失败 / 无 embedding 时返回空数组，systemMessage 原样透传 —— 绝不影响对话本身
    const memories = hasUser ? await recallMemories(userId, prompt) : []
    const effectiveSystemMessage = composeSystemMessage(systemMessage, memories)
    if (memories.length > 0)
      globalThis.console.log(`[memory] 已注入 ${memories.length} 条历史记忆`) // 便于验证召回是否真的生效

    // 捕获最终回答文本，供本轮结束后刷新长期记忆（answer 是定稿事件）
    let answerText = ''
    // 本轮累计用量（随 answer 事件带出），收尾时落库
    let answerUsage: AgentUsage | undefined

    // 传入当前已注册的全部工具；结束时 runAgent 会发出 answer 事件
    await runAgent({
      messages: [...history, { role: 'user', content: prompt }],
      tools: list(),
      systemMessage: effectiveSystemMessage,
      signal: controller.signal,
      // 审批通道：仅登录用户可用。未登录（理论上被 requireAuth 挡住）时不给回调，
      // loop 按 fail-closed 直接拒绝需审批的工具
      requestApproval: hasUser
        ? request => awaitApproval({ runId, toolCallId: request.id, userId })
        : undefined,
      onEvent: (event) => {
        if (event.type === 'answer') {
          answerText = event.content
          answerUsage = event.usage
        }
        writeEvent(event)
      },
    })

    // 用量落库：失败只告警不抛出 —— 统计是旁路，绝不能因为它把已经跑完的一轮对话变成错误
    if (hasUser && answerUsage) {
      try {
        recordUsage({
          userId,
          conversationUuid: Number.isInteger(Number(conversationId)) ? Number(conversationId) : null,
          model: currentModel(),
          promptTokens: answerUsage.promptTokens,
          completionTokens: answerUsage.completionTokens,
          durationMs: answerUsage.durationMs,
        })
      }
      catch (error: any) {
        globalThis.console.warn('[usage] 用量落库失败：', error?.message ?? error)
      }
    }

    // 长期记忆刷新：fire-and-forget，不拖慢响应收尾；失败在 memory 内部静默降级。
    // 需要会话 uuid 才能挂靠记忆，前端未传（老客户端）则跳过
    const memoryConversationId = Number(conversationId)
    if (hasUser && Number.isInteger(memoryConversationId) && memoryConversationId > 0) {
      void rememberConversation({
        userId,
        conversationId: memoryConversationId,
        messages: [
          ...history,
          { role: 'user', content: prompt },
          ...(answerText ? [{ role: 'assistant' as const, content: answerText }] : []),
        ],
      })
    }
  }
  catch (error: any) {
    // 客户端主动中止属正常路径，不当作错误上报（连接已断，写了也没人收）
    if (error?.name !== 'AbortError')
      writeEvent({ type: 'error', message: error?.message ?? String(error) })
  }
  finally {
    clearInterval(heartbeat)
    // 循环结束（正常收尾 / 客户端断开 / 异常）时清空待决审批，按拒绝收尾 ——
    // 否则挂起的 Promise 会一直悬到 60s 超时才释放
    clearRunApprovals(runId)
    res.end()
  }
})

/**
 * 工具审批决策回传：唤醒 /agent-process 中挂起等待的循环。
 * SSE 是单向的，决策只能走这条独立请求 —— 见 agent/approvals.ts 的说明。
 */
router.post('/agent-approve', [limiter, requireAuth], (req, res) => {
  const { runId, toolCallId, approved } = req.body as { runId?: string; toolCallId?: string; approved?: boolean }
  const userId = Number(req.user?.sub)

  if (!runId || !toolCallId || !Number.isInteger(userId) || userId <= 0) {
    res.status(400).json({ status: 'Fail', message: '缺少 runId / toolCallId，或登录态无效', data: null })
    return
  }

  const result = resolveApproval({ runId, toolCallId, userId, approved: approved === true })

  if (result === 'not-found') {
    // 该运行已结束（循环退出 / 已超时），决策无处可送
    res.status(409).json({ status: 'Fail', message: '该审批已失效（运行已结束或已超时）', data: null })
    return
  }
  if (result === 'forbidden') {
    res.status(403).json({ status: 'Fail', message: '无权决策他人的运行', data: null })
    return
  }

  res.json({ status: 'Success', message: '', data: { approved: approved === true } })
})

router.post('/config', async (req, res) => {
  try {
    const response = await chatConfig()
    res.send(response)
  }
  catch (error) {
    res.send(error)
  }
})

router.post('/session', async (req, res) => {
  try {
    const AUTH_SECRET_KEY = process.env.AUTH_SECRET_KEY
    const auth = !!AUTH_SECRET_KEY // 如果配置了密钥，auth = true
    res.send({ status: 'Success', message: '', data: { auth, model: currentModel() } })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

/**
 * @deprecated 旧版前端门禁口令校验，已被 /auth/login（JWT）取代。
 * 仅为兼容未升级的前端保留；AUTH_SECRET_KEY 现语义为注册邀请码。
 */
router.post('/verify', async (req, res) => {
  try {
    const { token } = req.body
    const AUTH_SECRET_KEY = process.env.AUTH_SECRET_KEY

    if (!AUTH_SECRET_KEY) {
      res.send({ status: 'Success', message: 'No secret key configured', data: null })
      return
    }

    if (token === AUTH_SECRET_KEY)
      res.send({ status: 'Success', message: '', data: null })

    else
      res.send({ status: 'Fail', message: 'Invalid secret key', data: null })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

app.use('', authRouter)
app.use('/api', authRouter)
app.use('', router)
app.use('/api', router)
// conversationRouter 内部是 `router.use(requireAuth)`（整个路由全量鉴权），必须挂在主 router 之后：
// Express 按注册顺序执行中间件，挂前面会让 /session、/config、/verify 这些公开端点也被要求带 token，
// 前端守卫拿不到 /session 就跳 /500 —— 未登录用户（含退出登录后、新用户）永远打不开登录页。
// 两者的路由前缀不重叠（/conversation/* vs 其余），换序不影响各自匹配
app.use('', conversationRouter)
app.use('/api', conversationRouter)
// 用量汇总：同样全量 requireAuth，同样挂在主 router 之后（前缀 /usage/* 与其余不重叠）
app.use('', usageRouter)
app.use('/api', usageRouter)
app.set('trust proxy', 1)

// 鉴权自检：数据库可用性与鉴权模式在启动时明确打出，避免运行中才发现配置问题
try {
  getDb()
  getJwtSecret()
  globalThis.console.log(
    authConfig.inviteCode
      ? '[auth] 用户数据库就绪；已配置邀请码（AUTH_SECRET_KEY），注册需携带'
      : '[auth] 用户数据库就绪；未配置邀请码，开放注册（首个注册用户将成为管理员）',
  )
}
catch (error: any) {
  globalThis.console.error('[auth] 用户数据库初始化失败，注册/登录将不可用：', error?.message ?? error)
}

// 可选：MCP 兼容层 —— 从 MCP_SERVERS 环境变量拉取工具并桥接进 registry
// 例：MCP_SERVERS=[{"name":"demo","url":"http://localhost:3000/mcp"}]（配置格式错误时静默忽略）
try {
  const mcpServers = JSON.parse(process.env.MCP_SERVERS ?? '[]') as Array<{ name: string; url: string }>
  loadMcpTools(mcpServers).then((count) => {
    if (count > 0)
      globalThis.console.log(`[mcp] 桥接完成，共 ${count} 个工具`)
  })
}
catch {
  // MCP_SERVERS 格式非法时忽略，不影响服务启动
}

const server = app.listen(3002, () => globalThis.console.log('Server is running on port 3002'))

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    globalThis.console.error('端口 3002 已被占用：通常是上次的服务进程未完全退出（结束 npm/esno 时 node 子进程可能残留）。')
    globalThis.console.error('处理方法：netstat -ano | findstr :3002 找到占用端口的 PID，然后执行 taskkill /F /PID <PID>。')
    process.exit(1)
  }
  throw error
})

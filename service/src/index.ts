import express from 'express'
import type { RequestProps } from './types'
import type { ChatMessage } from './chatgpt'
import { chatConfig, chatReplyProcess, currentModel } from './chatgpt'

import { limiter } from './middleware/limiter'
import { runAgent } from './agent/loop'
import { list } from './agent/registry'
import type { AgentEvent } from './agent/types'
import './tools'
import { loadMcpTools } from './mcp'

const app = express()
const router = express.Router()

app.use(express.static('public'))
app.use(express.json())

app.all('*', (_, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Headers', 'authorization, Content-Type')
  res.header('Access-Control-Allow-Methods', '*')
  next()
})

router.post('/chat-process', [limiter], async (req, res) => {
  res.setHeader('Content-type', 'application/octet-stream')

  try {
    const { prompt, options = {}, systemMessage, temperature, top_p } = req.body as RequestProps
    let firstChunk = true
    await chatReplyProcess({
      message: prompt,
      lastContext: options,
      process: (chat: ChatMessage) => {
        res.write(firstChunk ? JSON.stringify(chat) : `\n${JSON.stringify(chat)}`)
        firstChunk = false
      },
      systemMessage,
      temperature,
      top_p,
    })
  }
  catch (error) {
    res.write(JSON.stringify(error))
  }
  finally {
    res.end()
  }
})

router.post('/agent-process', [limiter], async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()

  const { prompt, systemMessage, messages } = req.body as RequestProps
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
    // 传入当前已注册的全部工具；结束时 runAgent 会发出 answer 事件
    await runAgent({
      messages: [...history, { role: 'user', content: prompt }],
      tools: list(),
      systemMessage,
      signal: controller.signal,
      onEvent: writeEvent,
    })
  }
  catch (error: any) {
    // 客户端主动中止属正常路径，不当作错误上报（连接已断，写了也没人收）
    if (error?.name !== 'AbortError')
      writeEvent({ type: 'error', message: error?.message ?? String(error) })
  }
  finally {
    clearInterval(heartbeat)
    res.end()
  }
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

app.use('', router)
app.use('/api', router)
app.set('trust proxy', 1)

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

import express from 'express'
import type { RequestProps } from './types'
import type { ChatMessage } from './chatgpt'
import { chatConfig, chatReplyProcess, currentModel } from './chatgpt'

import { limiter } from './middleware/limiter'
import { runAgent } from './agent/loop'
import { list } from './agent/registry'
import type { AgentEvent } from './agent/types'

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

  const { prompt, systemMessage } = req.body as RequestProps
  const writeEvent = (event: AgentEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  try {
    // 传入当前已注册的全部工具；结束时 runAgent 会发出 answer 事件
    await runAgent({
      messages: [{ role: 'user', content: prompt }],
      tools: list(),
      systemMessage,
      onEvent: writeEvent,
    })
  }
  catch (error: any) {
    writeEvent({ type: 'error', message: error?.message ?? String(error) })
  }
  finally {
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
    const auth = !!AUTH_SECRET_KEY  // 如果配置了密钥，auth = true
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

    if (token === AUTH_SECRET_KEY) {
      res.send({ status: 'Success', message: '', data: null })
    }
    else {
      res.send({ status: 'Fail', message: 'Invalid secret key', data: null })
    }
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

app.use('', router)
app.use('/api', router)
app.set('trust proxy', 1)

const server = app.listen(3002, () => globalThis.console.log('Server is running on port 3002'))

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    globalThis.console.error('端口 3002 已被占用：通常是上次的服务进程未完全退出（结束 npm/esno 时 node 子进程可能残留）。')
    globalThis.console.error('处理方法：netstat -ano | findstr :3002 找到占用端口的 PID，然后执行 taskkill /F /PID <PID>。')
    process.exit(1)
  }
  throw error
})

<script setup lang='ts'>
import type { Ref } from 'vue'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { storeToRefs } from 'pinia'
import { NAutoComplete, NButton, NInput, useDialog, useMessage } from 'naive-ui'
import { toPng } from 'html-to-image'
import { Message } from './components'
import EmptyState from './components/EmptyState/index.vue'
import { useScroll } from './hooks/useScroll'
import { useChat } from './hooks/useChat'
import { useUsingContext } from './hooks/useUsingContext'
import HeaderComponent from './components/Header/index.vue'
import { HoverButton, SvgIcon } from '@/components/common'
import { useBasicLayout } from '@/hooks/useBasicLayout'
import { useChatStore, usePromptStore, useSettingStore } from '@/store'
import type { AgentResumeCursor } from '@/api'
import { AgentResumeUnavailableError, fetchAgentApprove, fetchAgentProcess, fetchChatAPIProcessStream } from '@/api'
import { t } from '@/locales'

let controller = new AbortController()

// 当前 Agent 运行的 runId（来自响应头 X-Agent-Run-Id）：审批决策凭它回传 /agent-approve。
// 同一时刻只可能有一个运行在跑（loading 挡住了并发提交），单个变量足够
let activeRunId = ''
// 当前运行正在累积的步骤流与其消息下标。审批点击（用户）与 SSE 事件（循环）是两条写入路径，
// 共享同一个数组对象才能保证互不覆盖 —— 各存一份的话，后写的那次会把对方的决策状态抹掉
let activeSteps: Chat.AgentStep[] = []
let activeStepsIndex = -1

/**
 * 断点续传游标（8.2）：断线后凭它请服务端补发缺口。
 *
 * 与 activeRunId 分开存，因为两者生命周期**正好相反**：activeRunId 在连接关闭时就清掉
 * （审批决策再无接收方），而游标恰恰必须活过断线那一刻 —— 它存在的唯一理由就是断线后还能续。
 *
 * `text` 一并带着：流式渲染有节流（AGENT_STREAM_THROTTLE_MS），节流窗口内「已收到但还没落盘」
 * 的增量只存在于内存的 streamBuffer 里。断线时若不在这里留一份，续传接上后会凭空缺一段正文。
 *
 * `index` 是这条运行写在哪条助手消息上：停滞横幅是**逐条消息**的，只认游标不认下标的话，
 * 用户在新消息上跑完一轮后，再去点旧消息上那条横幅，就会把旧消息的坑续到新运行上。
 */
let resumeCursor: ResumeCursor | null = null

/** 续传游标在 API 需要的字段之外，额外带上本地恢复用的正文与消息下标 */
type ResumeCursor = AgentResumeCursor & { text: string; index: number }

const openLongReply = import.meta.env.VITE_GLOB_OPEN_LONG_REPLY === 'true'

/** Agent 模式携带的历史消息条数上限（取最近 N 条，防止超长会话撑爆模型上下文） */
const AGENT_HISTORY_LIMIT = 20

/** Agent 流式渲染节流间隔（毫秒）：避免每个 token 都触发一次全量状态写盘 */
const AGENT_STREAM_THROTTLE_MS = 60

/** agentSteps 落盘时单个 tool_result 内容的字符数上限（超长会随每次写盘重复序列化，撑爆 localStorage） */
const AGENT_TOOL_RESULT_MAX_CHARS = 2000

/** Agent 连接静默超时（毫秒）：超过此时长没收到任何事件则提示「连接可能已中断」 */
const AGENT_SILENCE_TIMEOUT_MS = 30000

const route = useRoute()
const dialog = useDialog()
const ms = useMessage()

const chatStore = useChatStore()
const settingStore = useSettingStore()

const { isMobile } = useBasicLayout()
const { addChat, updateChat, updateChatSome, getChatByUuidAndIndex } = useChat()
const { scrollRef, scrollToBottom, scrollToBottomIfAtBottom } = useScroll()
const { usingContext, toggleUsingContext } = useUsingContext()

const { uuid } = route.params as { uuid: string }

const dataSources = computed(() => chatStore.getChatByUuid(+uuid))
// 上下文链选取：取全部助手消息，而非只取带 conversationOptions 的。
// 旧过滤会把 Agent 消息（conversationOptions 为 null）排除在外，导致 lastContext 跳过 Agent 轮次、
// 错接到更早的普通轮次；现在取最近一条助手消息 —— 若它是 Agent 消息则 conversationOptions 为 null，
// 普通模式自然从新一轮开始，不会接错链
const conversationList = computed(() => dataSources.value.filter(item => !item.inversion))

const prompt = ref<string>('')
const loading = ref<boolean>(false)
const inputRef = ref<Ref | null>(null)

const isRecording = ref(false)
const recognition = ref<any>(null)
const voices = ref<SpeechSynthesisVoice[]>([])

// 添加PromptStore
const promptStore = usePromptStore()

// 使用storeToRefs，保证store修改后，联想部分能够重新渲染
// PromptList 类型为空元组，这里显式声明为 prompt 列表结构
const { promptList: promptTemplate } = storeToRefs(promptStore) as { promptList: { value: Array<{ key: string; value: string }> } }

// 未知原因刷新页面，loading 状态不会重置，手动重置
// agentStalled 同理：刷新后连接必然已断，旧的「连接可能已中断」提示是陈旧信息，一并清掉
// （消息本身还在，用户仍可用常规的「重新生成」按钮重试）
dataSources.value.forEach((item, index) => {
  if (item.loading || item.agentStalled)
    updateChatSome(+uuid, index, { loading: false, agentStalled: false })
})

function handleSubmit() {
  onConversation()
}

function handleExampleSelect(example: string) {
  prompt.value = example
  handleSubmit()
}

function handleReply(text: string) {
  prompt.value = text
  inputRef.value?.focus?.()
}

function toggleAgentMode() {
  settingStore.updateSetting({ agentMode: !settingStore.agentMode })
}

/**
 * 审批卡片状态迁移：把 id 匹配、且当前恰为 from 的审批步骤改为 to，并写回消息。
 * 用「新对象替换 + 新数组」而非就地改字段 —— 就地改不会触发已渲染步骤的重渲染。
 * 返回是否命中：from 守卫让「重复点击」与「回滚时状态已被 tool_result 改写」都能安全跳过
 */
function setApprovalDecision(toolCallId: string, from: boolean | undefined, to: boolean | undefined): boolean {
  const stepIndex = activeSteps.findIndex(step => step.type === 'tool_approval' && step.id === toolCallId && step.approved === from)
  if (stepIndex === -1)
    return false
  activeSteps[stepIndex] = { ...activeSteps[stepIndex], approved: to }
  updateChatSome(+uuid, activeStepsIndex, { agentSteps: [...activeSteps] })
  return true
}

/** 用户在审批卡片上点了「允许 / 拒绝」：乐观落定 → 回传决策 → 失败回滚为待决策 */
async function handleApprove(toolCallId: string, approved: boolean) {
  // 只接受「待决策 → 已决策」这一条迁移：重复点击、以及早已决策/失效的卡片都在此被忽略
  if (!setApprovalDecision(toolCallId, undefined, approved))
    return

  if (!activeRunId) {
    // 本轮运行已结束，决策无处可送：回滚，避免卡片停在「已允许」而实际什么都没发生
    setApprovalDecision(toolCallId, approved, undefined)
    ms.error('该审批已失效：本轮运行已结束')
    return
  }

  try {
    await fetchAgentApprove(activeRunId, toolCallId, approved)
  }
  catch (error: any) {
    // 回滚带 from 守卫：若期间已收到 tool_result（后端超时按拒绝处理），此处不会把它改回待决策
    setApprovalDecision(toolCallId, approved, undefined)
    ms.error(error?.message ?? '审批提交失败，请重试')
  }
}

/** Agent 对话核心：向 userMsgIndex + 1 处的助手占位消息流式写入，onConversation 与 onRegenerate 共用。
 * userMsgIndex 为本轮 user 消息下标（历史上下文取其之前的消息）。
 * 传 resume 则走**续传**：不重跑循环，只请服务端补发断线期间漏掉的事件，已有内容原地保留。 */
async function runAgentConversation(promptText: string, controller: AbortController, userMsgIndex: number, options: Chat.ConversationRequest = {}, resume?: ResumeCursor) {
  const targetIndex = userMsgIndex + 1
  // 续传：步骤流从消息上恢复，绝不从零开始 —— 用户已经看到的工具调用过程必须原样留着
  const agentSteps: Chat.AgentStep[] = resume
    ? [...(getChatByUuidAndIndex(+uuid, targetIndex)?.agentSteps ?? [])]
    : []
  // 交给审批点击共用（见 activeSteps 的说明）
  activeSteps = agentSteps
  activeStepsIndex = targetIndex
  // 实时增量缓冲：text_delta 累积于此并即时渲染。
  // 收到 thought 说明该轮调用了工具 → 缓冲归入步骤流；收到 answer 则用定稿文本覆盖。
  // 续传时从游标恢复（含节流窗口内未落盘的那截），而不是用消息上那份可能偏旧的文本
  let streamBuffer = resume?.text ?? ''
  // 唯一改动 streamBuffer 的入口：顺带同步游标里的副本，避免某个分支漏同步
  const setStreamBuffer = (value: string) => {
    streamBuffer = value
    if (resumeCursor)
      resumeCursor.text = value
  }
  let lastRenderAt = 0
  /** force 用于绕过节流：续传恢复后要把补上的文本立刻显示出来，不能等下一个 delta */
  const renderStream = (force = false) => {
    const now = Date.now()
    if (!force && now - lastRenderAt < AGENT_STREAM_THROTTLE_MS)
      return
    lastRenderAt = now
    updateChatSome(+uuid, targetIndex, { text: streamBuffer, loading: true })
    scrollToBottomIfAtBottom()
  }
  if (resume)
    renderStream(true)

  // 本轮是否收到了终局事件（answer / error）。没有就说明循环是中途断的 ——
  // 服务端随连接断开中止、或进程重启，都会走到这里。不提示的话，用户只会盯着半截回答
  let sawTerminal = false
  // 是否因断线而提前收场且**留下了可续传的游标**（见下方 catch）。它要区分的是
  // 「还能续」与「服务端那份运行已经没了」这两种都算「没跑完」的情况
  let resumableBreak = false

  // 历史上下文：取本轮 user 消息之前的消息，只取纯文本，剔除出错与空消息
  // usingContext 关闭时传空数组，退化为单轮对话
  const history = usingContext.value
    ? dataSources.value
      .slice(0, userMsgIndex)
      .slice(-AGENT_HISTORY_LIMIT)
      .filter(item => !item.error && !!item.text && item.text.trim() !== '')
      .map(item => ({
        role: (item.inversion ? 'user' : 'assistant') as 'user' | 'assistant',
        content: item.text,
      }))
    : []

  // 静默超时：每个事件都重置计时；超时未收到任何事件 → 标记 stalled（气泡内提示 + 手动重试）
  let silenceTimer: ReturnType<typeof setTimeout> | null = null
  const clearSilenceTimer = () => {
    if (silenceTimer) {
      clearTimeout(silenceTimer)
      silenceTimer = null
    }
  }
  // 等待用户审批期间豁免静默计时：循环本就挂起在等决策，收不到事件是预期行为，
  // 照常计时会把「等你点允许」误判成断线并 abort 掉这次运行
  // 读本地数组而非 store：审批点击与事件流写的是同一份（activeSteps === agentSteps），这里必然最新
  const hasPendingApproval = () =>
    agentSteps.some(step => step.type === 'tool_approval' && step.approved === undefined)
  const resetSilenceTimer = () => {
    clearSilenceTimer()
    if (hasPendingApproval())
      return
    silenceTimer = setTimeout(() => {
      silenceTimer = null
      // 连接可能已中断：中止这个已无意义的请求（释放输入框与「停止」按钮，否则重试会被 loading 挡住），
      // 提示用户手动重试。不自动重试 —— Agent 循环有副作用（工具已执行、token 已消耗），自动重试会重复执行并重复计费
      controller.abort()
      updateChatSome(+uuid, targetIndex, { loading: false, agentStalled: true })
    }, AGENT_SILENCE_TIMEOUT_MS)
  }

  await fetchAgentProcess({
    prompt: promptText,
    systemMessage: settingStore.systemMessage,
    messages: history,
    // 会话 uuid：后端据此把长期记忆摘要挂到本会话上
    conversationId: +uuid,
    signal: controller.signal,
    // 有续传目标时服务端只补发缺口、不跑新循环（拿不到就退化成普通新运行）
    ...(resume ? { resume } : {}),
    onRunId: (runId) => {
      activeRunId = runId
      // 续传时响应头回的是同一个 runId：保留游标里已收到的 seq，绝不能清零 ——
      // 清零会让服务端把整段事件重放一遍，用户看到内容凭空翻倍
      if (!resumeCursor || resumeCursor.runId !== runId)
        resumeCursor = { runId, lastSeq: 0, text: '', index: targetIndex }
    },
    onStateChange: (state) => {
      // connecting 就开始计时：连接被静默黑洞化时（服务端接了连接却永不响应）根本等不到首个事件，
      // 只在 live 后计时会让这种最需要提示的情况反而检测不到
      if (state === 'connecting' || state === 'live') {
        resetSilenceTimer()
      }
      else if (state === 'closed') {
        clearSilenceTimer()
        // 运行已结束：审批决策再无接收方，清掉避免后续点击拿着过期 runId 去请求。
        // 注意别顺手把 resumeCursor 也清了 —— 它要活过这次关闭，供用户点「继续」时用
        activeRunId = ''
      }
    },
    onEvent: (event) => {
      // 收到任何事件都说明连接仍活着：清掉中断提示并重置静默计时
      if (getChatByUuidAndIndex(+uuid, targetIndex)?.agentStalled)
        updateChatSome(+uuid, targetIndex, { loading: true, agentStalled: false })
      resetSilenceTimer()
      // 推进续传游标：断线后凭它报「我收到哪了」。老后端不带 seq 时游标原地不动，
      // 后续续传会因位置对不上被服务端拒绝，自然退回整轮重发
      if (resumeCursor && typeof event.seq === 'number')
        resumeCursor.lastSeq = event.seq
      if (event.type === 'text_delta') {
        setStreamBuffer(streamBuffer + (event.content ?? ''))
        renderStream()
      }
      else if (event.type === 'thought') {
        // 该轮模型调用了工具，已流式渲染的文本归属「思考」；优先用缓冲，回退到事件内容
        const thoughtText = streamBuffer || event.content || ''
        if (thoughtText.trim() !== '')
          agentSteps.push({ type: 'thought', content: thoughtText })
        setStreamBuffer('')
        updateChatSome(+uuid, targetIndex, { text: '', agentSteps: [...agentSteps] })
      }
      else if (event.type === 'tool_call') {
        agentSteps.push({ type: 'tool_call', id: event.id, name: event.name, arguments: event.arguments })
        updateChatSome(+uuid, targetIndex, { agentSteps: [...agentSteps] })
      }
      else if (event.type === 'tool_approval_request') {
        // 需审批的工具已挂起等决策：卡片内渲染「允许 / 拒绝」
        agentSteps.push({ type: 'tool_approval', id: event.id, name: event.name, arguments: event.arguments, reason: event.reason })
        updateChatSome(+uuid, targetIndex, { agentSteps: [...agentSteps] })
        // 重新计时：此时状态里已有待决策步骤，resetSilenceTimer 会据此豁免计时
        resetSilenceTimer()
      }
      else if (event.type === 'tool_result') {
        // 落盘前裁剪超长结果：后端已按 AGENT_TOOL_RESULT_MAX_CHARS（默认 8000）截断一份喂给模型，
        // 这里再截更短的一份（2000），只关落盘体积与渲染，不影响模型实际看到的内容
        const rawContent = event.content ?? ''
        const content = rawContent.length > AGENT_TOOL_RESULT_MAX_CHARS
          ? `${rawContent.slice(0, AGENT_TOOL_RESULT_MAX_CHARS)}\n[已截断：原 ${rawContent.length} 字符]`
          : rawContent
        // 结果已到但卡片仍是「待决策」→ 不是用户点的（后端 60s 超时按拒绝处理），落定为已拒绝。
        // 否则卡片永远停在待决策态，且静默计时会被永久豁免
        if (setApprovalDecision(event.id ?? '', undefined, false)) {
          // 刚解除豁免，补一次计时（上方那次 reset 因「有待决策步骤」而没有真正计时）
          resetSilenceTimer()
        }
        agentSteps.push({ type: 'tool_result', id: event.id, name: event.name, content })
        updateChatSome(+uuid, targetIndex, { agentSteps: [...agentSteps] })
      }
      else if (event.type === 'answer') {
        // 定稿：用完整文本覆盖流式缓冲
        setStreamBuffer('')
        // 本轮已跑完，没有可续的东西了：游标留着只会让下一次「继续」拿到一份过期的位置
        resumeCursor = null
        sawTerminal = true
        clearSilenceTimer()
        updateChat(
          +uuid,
          targetIndex,
          {
            dateTime: new Date().toLocaleString(),
            text: event.content ?? '',
            inversion: false,
            error: false,
            loading: true,
            agentStalled: false,
            agentSteps: [...agentSteps],
            // 老后端不返回 usage 时缺省，消息上就不带这一行
            ...(event.usage ? { usage: event.usage as Chat.AgentUsage } : {}),
            conversationOptions: null,
            requestOptions: { prompt: promptText, options: { ...options } },
          },
        )
        scrollToBottomIfAtBottom()
      }
      else if (event.type === 'error') {
        setStreamBuffer('')
        // 运行以错误收尾，循环已退出：续传只会把同一份错误再放一遍
        resumeCursor = null
        sawTerminal = true
        updateChatSome(
          +uuid,
          targetIndex,
          { text: `[Agent 错误] ${event.message ?? ''}`, error: true, loading: false },
        )
      }
    },
  }).catch((error: any) => {
    // 断线但有续传游标：不当成错误收场，改为「可继续」的停滞态 —— 已生成的部分保留在屏幕上，
    // 用户点「继续」就能补齐缺口。这是 8.2 要修的主场景：网络抖一下不该丢掉半篇回答
    if (resumeCursor && error?.name !== 'AbortError' && error?.name !== 'AgentResumeUnavailableError') {
      renderStream(true)
      resumableBreak = true
      updateChatSome(+uuid, targetIndex, { loading: false, agentStalled: true })
      return
    }
    // 无游标（首个事件都没收到）/ 用户主动停止 / 续传被拒：交回上层按原有错误路径处理
    throw error
  })
  clearSilenceTimer()
  updateChatSome(+uuid, targetIndex, { loading: false })

  // 流正常读完却没等到终局事件：循环是中途断的（服务端已中止 / 进程重启）。
  // 同样给「可继续」的提示 —— 只是这次服务端那份运行已经没了，游标续不出新东西，
  // 清掉后点「继续」会走整轮重发（handleAgentRetry 找不到游标时的既有回退）
  if (!sawTerminal && !resumableBreak) {
    resumeCursor = null
    updateChatSome(+uuid, targetIndex, { agentStalled: true })
  }
}

async function onConversation() {
  let message = prompt.value

  if (loading.value)
    return

  if (!message || message.trim() === '')
    return

  // 新一轮对话与上一轮的续传位置无关（它写的是另一条消息），别让它被误当成续传目标
  resumeCursor = null
  controller = new AbortController()

  addChat(
    +uuid,
    {
      dateTime: new Date().toLocaleString(),
      text: message,
      inversion: true,
      error: false,
      conversationOptions: null,
      requestOptions: { prompt: message, options: null },
    },
  )
  scrollToBottom()

  loading.value = true
  prompt.value = ''

  let options: Chat.ConversationRequest = {}
  const lastContext = conversationList.value[conversationList.value.length - 1]?.conversationOptions

  if (lastContext && usingContext.value)
    options = { ...lastContext }

  addChat(
    +uuid,
    {
      dateTime: new Date().toLocaleString(),
      text: t('chat.thinking'),
      loading: true,
      inversion: false,
      error: false,
      conversationOptions: null,
      requestOptions: { prompt: message, options: { ...options } },
    },
  )
  scrollToBottom()

  // Agent 模式：走 /agent-process（核心逻辑抽为 runAgentConversation，onRegenerate 共用）
  try {
    if (settingStore.agentMode) {
      // 本轮 user 消息位于倒数第二（助手占位在最后）
      await runAgentConversation(message, controller, dataSources.value.length - 2, options)
    }
    else {
      let lastText = ''
      const fetchChatAPIOnce = async () => {
        await fetchChatAPIProcessStream({
          prompt: message,
          options,
          signal: controller.signal,
          onEvent: (data) => {
            // 后端错误帧（status: 'Fail'）直接展示，不再依赖抛错
            if (data.status === 'Fail') {
              updateChatSome(
                +uuid,
                dataSources.value.length - 1,
                { text: data.message ?? 'Error', error: true, loading: false },
              )
              return
            }

            updateChat(
              +uuid,
              dataSources.value.length - 1,
              {
                dateTime: new Date().toLocaleString(),
                text: lastText + (data.text ?? ''),
                inversion: false,
                error: false,
                loading: true,
                conversationOptions: { conversationId: data.conversationId, parentMessageId: data.id },
                requestOptions: { prompt: message, options: { ...options } },
              },
            )

            if (openLongReply && data.detail?.choices[0]?.finish_reason === 'length') {
              options.parentMessageId = data.id
              lastText = data.text
              message = ''
              return fetchChatAPIOnce()
            }

            scrollToBottomIfAtBottom()
          },
        })
        updateChatSome(+uuid, dataSources.value.length - 1, { loading: false })
      }

      await fetchChatAPIOnce()
    }
  }
  catch (error: any) {
    const errorMessage = error?.message ?? t('common.wrong')

    if (error?.message === 'canceled' || error?.name === 'AbortError') {
      updateChatSome(
        +uuid,
        dataSources.value.length - 1,
        {
          loading: false,
        },
      )
      scrollToBottomIfAtBottom()
      return
    }

    const currentChat = getChatByUuidAndIndex(+uuid, dataSources.value.length - 1)

    if (currentChat?.text && currentChat.text !== '') {
      updateChatSome(
        +uuid,
        dataSources.value.length - 1,
        {
          text: `${currentChat.text}\n[${errorMessage}]`,
          error: false,
          loading: false,
        },
      )
      return
    }

    updateChat(
      +uuid,
      dataSources.value.length - 1,
      {
        dateTime: new Date().toLocaleString(),
        text: errorMessage,
        inversion: false,
        error: true,
        loading: false,
        conversationOptions: null,
        requestOptions: { prompt: message, options: { ...options } },
      },
    )
    scrollToBottomIfAtBottom()
  }
  finally {
    loading.value = false
  }
}

async function onRegenerate(index: number) {
  if (loading.value)
    return

  // 整轮重发会把消息清空重来，旧的续传位置随之作废：留着只会在下次失败时误判为「可续传」
  resumeCursor = null
  controller = new AbortController()

  const { requestOptions } = dataSources.value[index]

  let message = requestOptions?.prompt ?? ''

  let options: Chat.ConversationRequest = {}

  if (requestOptions.options)
    options = { ...requestOptions.options }

  loading.value = true

  // 该消息此前由 Agent 生成（agentSteps 字段存在，可能为空数组——本轮没用工具）或当前开着 Agent 模式
  // → 重试仍走 /agent-process。用 Array.isArray 而非 length 判定：空数组也是 Agent 产物
  const useAgent = settingStore.agentMode || Array.isArray(dataSources.value[index].agentSteps)

  updateChat(
    +uuid,
    index,
    {
      dateTime: new Date().toLocaleString(),
      text: '',
      inversion: false,
      error: false,
      loading: true,
      agentSteps: [],
      agentStalled: false,
      conversationOptions: null,
      requestOptions: { prompt: message, options: { ...options } },
    },
  )

  try {
    if (useAgent) {
      // 被重试的助手消息位于 index，其对应的 user 消息在 index - 1
      await runAgentConversation(message, controller, index - 1, options)
      updateChatSome(+uuid, index, { loading: false })
    }
    else {
      let lastText = ''
      const fetchChatAPIOnce = async () => {
        await fetchChatAPIProcessStream({
          prompt: message,
          options,
          signal: controller.signal,
          onEvent: (data) => {
            // 后端错误帧（status: 'Fail'）直接展示，不再依赖抛错
            if (data.status === 'Fail') {
              updateChatSome(
                +uuid,
                index,
                { text: data.message ?? 'Error', error: true, loading: false },
              )
              return
            }

            updateChat(
              +uuid,
              index,
              {
                dateTime: new Date().toLocaleString(),
                text: lastText + (data.text ?? ''),
                inversion: false,
                error: false,
                loading: true,
                conversationOptions: { conversationId: data.conversationId, parentMessageId: data.id },
                requestOptions: { prompt: message, options: { ...options } },
              },
            )

            if (openLongReply && data.detail?.choices[0]?.finish_reason === 'length') {
              options.parentMessageId = data.id
              lastText = data.text
              message = ''
              return fetchChatAPIOnce()
            }
          },
        })
        updateChatSome(+uuid, index, { loading: false })
      }
      await fetchChatAPIOnce()
    }
  }
  catch (error: any) {
    // AbortError 为用户主动停止（Agent 链路 fetch 中止抛 AbortError），静默处理
    if (error?.message === 'canceled' || error?.name === 'AbortError') {
      updateChatSome(
        +uuid,
        index,
        {
          loading: false,
        },
      )
      return
    }

    const errorMessage = error?.message ?? t('common.wrong')

    updateChat(
      +uuid,
      index,
      {
        dateTime: new Date().toLocaleString(),
        text: errorMessage,
        inversion: false,
        error: true,
        loading: false,
        conversationOptions: null,
        requestOptions: { prompt: message, options: { ...options } },
      },
    )
  }
  finally {
    loading.value = false
  }
}

/**
 * 停滞消息的「继续」（8.2）：优先续传补齐缺口，续传不可用才整轮重发。
 *
 * 与 onRegenerate 的关键区别：续传路径**不清空已有内容** —— 用户已经看到的部分回答与工具
 * 调用过程原样留着，补上的只是断线期间漏掉的事件。整轮重发会推倒重来，那是最后的退路。
 */
async function handleAgentRetry(index: number) {
  if (loading.value)
    return

  const cursor = resumeCursor
  // 没有游标（运行还没开跑就断了 / 已正常跑完），或游标属于另一条消息：
  // 无从续传，直接走原有的整轮重发
  if (!cursor || cursor.index !== index) {
    onRegenerate(index)
    return
  }

  controller = new AbortController()
  loading.value = true

  const { requestOptions } = dataSources.value[index]
  const message = requestOptions?.prompt ?? ''
  const options: Chat.ConversationRequest = requestOptions?.options ? { ...requestOptions.options } : {}

  let resumeUnavailable = false
  try {
    await runAgentConversation(message, controller, index - 1, options, cursor)
    updateChatSome(+uuid, index, { loading: false })
  }
  catch (error: any) {
    if (error instanceof AgentResumeUnavailableError) {
      resumeUnavailable = true
    }
    else if (error?.message === 'canceled' || error?.name === 'AbortError') {
      updateChatSome(+uuid, index, { loading: false })
    }
    else {
      // 续传路径上的其它失败：退回停滞态让用户再点一次，而不是把已生成的内容换成一条错误
      ms.error(error?.message ?? t('common.wrong'))
      updateChatSome(+uuid, index, { loading: false, agentStalled: true })
    }
  }
  finally {
    loading.value = false
  }

  // 放在 finally 之后：这里的 loading 复位若与 onRegenerate 置上的 loading 撞在一起，
  // 会让新一轮运行期间输入框提前解禁、停止按钮消失
  if (resumeUnavailable) {
    resumeCursor = null
    ms.warning('续传窗口已过期，已改为重新生成')
    onRegenerate(index)
  }
}

function handleExport() {
  if (loading.value)
    return

  const d = dialog.warning({
    title: t('chat.exportImage'),
    content: t('chat.exportImageConfirm'),
    positiveText: t('common.yes'),
    negativeText: t('common.no'),
    onPositiveClick: async () => {
      try {
        d.loading = true
        const ele = document.getElementById('image-wrapper')
        const imgUrl = await toPng(ele as HTMLDivElement)
        const tempLink = document.createElement('a')
        tempLink.style.display = 'none'
        tempLink.href = imgUrl
        tempLink.setAttribute('download', 'chat-shot.png')
        if (typeof tempLink.download === 'undefined')
          tempLink.setAttribute('target', '_blank')
        document.body.appendChild(tempLink)
        tempLink.click()
        document.body.removeChild(tempLink)
        window.URL.revokeObjectURL(imgUrl)
        d.loading = false
        ms.success(t('chat.exportSuccess'))
        Promise.resolve()
      }
      catch (error: any) {
        ms.error(t('chat.exportFailed'))
      }
      finally {
        d.loading = false
      }
    },
  })
}

function handleDelete(index: number) {
  if (loading.value)
    return

  dialog.warning({
    title: t('chat.deleteMessage'),
    content: t('chat.deleteMessageConfirm'),
    positiveText: t('common.yes'),
    negativeText: t('common.no'),
    onPositiveClick: () => {
      chatStore.deleteChatByUuid(+uuid, index)
    },
  })
}

function handleClear() {
  if (loading.value)
    return

  dialog.warning({
    title: t('chat.clearChat'),
    content: t('chat.clearChatConfirm'),
    positiveText: t('common.yes'),
    negativeText: t('common.no'),
    onPositiveClick: () => {
      chatStore.clearChatByUuid(+uuid)
    },
  })
}

function handleEnter(event: KeyboardEvent) {
  if (!isMobile.value) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      handleSubmit()
    }
  }
  else {
    if (event.key === 'Enter' && event.ctrlKey) {
      event.preventDefault()
      handleSubmit()
    }
  }
}

function handleStop() {
  if (loading.value) {
    controller.abort()
    loading.value = false
    // 用户主动停止：服务端会随连接断开中止这次运行，续传也补不出新东西，游标直接作废
    resumeCursor = null
  }
}

// 可优化部分
// 搜索选项计算，这里使用value作为索引项，所以当出现重复value时渲染异常(多项同时出现选中效果)
// 理想状态下其实应该是key作为索引项,但官方的renderOption会出现问题，所以就需要value反renderLabel实现
const searchOptions = computed(() => {
  if (prompt.value.startsWith('/')) {
    return promptTemplate.value.filter((item: { key: string }) => item.key.toLowerCase().includes(prompt.value.substring(1).toLowerCase())).map((obj: { value: any }) => {
      return {
        label: obj.value,
        value: obj.value,
      }
    })
  }
  else {
    return []
  }
})

// value反渲染key
const renderOption = (option: { label: string }) => {
  for (const i of promptTemplate.value) {
    if (i.value === option.label)
      return [i.key]
  }
  return []
}

const placeholder = computed(() => {
  if (isMobile.value)
    return t('chat.placeholderMobile')
  return t('chat.placeholder')
})

const buttonDisabled = computed(() => {
  return loading.value || !prompt.value || prompt.value.trim() === ''
})

const footerClass = computed(() => {
  let classes = ['p-4']
  if (isMobile.value)
    classes = ['sticky', 'left-0', 'bottom-0', 'right-0', 'p-2', 'pr-3', 'overflow-hidden']
  return classes
})

function startRecording() {
  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
    ms.error('您的浏览器不支持语音识别功能')
    return
  }

  const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  recognition.value = new SpeechRecognition()
  recognition.value.lang = 'zh-CN'
  recognition.value.continuous = true
  recognition.value.interimResults = true

  recognition.value.onresult = (event: any) => {
    let finalTranscript = ''
    let interimTranscript = ''

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript
      if (event.results[i].isFinal)
        finalTranscript += transcript

      else
        interimTranscript += transcript
    }

    if (finalTranscript)
      prompt.value = finalTranscript

    else if (interimTranscript)
      prompt.value = interimTranscript
  }

  recognition.value.onerror = (event: any) => {
    console.error('Speech recognition error:', event.error)
    isRecording.value = false
    if (event.error === 'not-allowed')
      ms.error('请允许麦克风权限')

    else if (event.error === 'no-speech')
      ms.error('未检测到语音')

    else
      ms.error('语音识别失败')
  }

  recognition.value.onend = () => {
    isRecording.value = false
  }

  recognition.value.start()
  isRecording.value = true
}

function stopRecording() {
  if (recognition.value) {
    recognition.value.stop()
    isRecording.value = false
  }
}

function toggleRecording() {
  if (isRecording.value)
    stopRecording()

  else
    startRecording()
}

function loadVoices() {
  voices.value = window.speechSynthesis.getVoices()
}

function speakText(text: string) {
  if (!text)
    return

  const synth = window.speechSynthesis
  synth.cancel()

  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = 'zh-CN'
  utterance.rate = 0.8
  utterance.pitch = 1
  utterance.volume = 1

  const chineseVoices = voices.value.filter(voice => voice.lang.includes('zh'))
  if (chineseVoices.length > 0)
    utterance.voice = chineseVoices[0]

  utterance.onend = () => {
    synth.cancel()
  }

  utterance.onerror = (event) => {
    console.error('Speech synthesis error:', event.error)
  }

  synth.speak(utterance)
}

onMounted(() => {
  scrollToBottom()
  if (inputRef.value && !isMobile.value)
    inputRef.value?.focus()

  if ('speechSynthesis' in window) {
    window.speechSynthesis.onvoiceschanged = loadVoices
    loadVoices()
  }
})

onUnmounted(() => {
  if (loading.value)
    controller.abort()
})
</script>

<template>
  <div class="flex flex-col w-full h-full">
    <HeaderComponent v-if="isMobile" :using-context="usingContext" @export="handleExport" @handle-clear="handleClear" />
    <main class="flex-1 overflow-hidden">
      <div id="scrollRef" ref="scrollRef" class="h-full overflow-hidden overflow-y-auto">
        <div class="w-full max-w-screen-xl m-auto dark:bg-[#101014]" :class="[isMobile ? 'p-2' : 'p-4']">
          <div id="image-wrapper" class="relative">
            <template v-if="!dataSources.length">
              <EmptyState @select="handleExampleSelect" />
            </template>
            <template v-else>
              <div>
                <Message
                  v-for="(item, index) of dataSources" :key="index" :date-time="item.dateTime" :text="item.text"
                  :inversion="item.inversion" :error="item.error" :loading="item.loading" :quote="item.quote"
                  :agent-steps="item.agentSteps"
                  :agent-stalled="item.agentStalled"
                  :usage="item.usage"
                  @regenerate="onRegenerate(index)" @retry="handleAgentRetry(index)" @delete="handleDelete(index)"
                  @reply="handleReply" @speak="speakText" @approve="handleApprove"
                />
                <div class="sticky bottom-0 left-0 flex justify-center">
                  <NButton v-if="loading" type="warning" @click="handleStop">
                    <template #icon>
                      <SvgIcon icon="ri:stop-circle-line" />
                    </template>
                    {{ t('common.stopResponding') }}
                  </NButton>
                </div>
              </div>
            </template>
          </div>
        </div>
      </div>
    </main>
    <footer :class="footerClass">
      <div class="w-full max-w-screen-xl m-auto">
        <div class="flex items-center justify-between space-x-2">
          <HoverButton v-if="!isMobile" tooltip="清空当前会话" placement="top" @click="handleClear">
            <span class="text-xl text-[#4f555e] dark:text-white">
              <SvgIcon icon="ri:delete-bin-line" />
            </span>
          </HoverButton>
          <HoverButton v-if="!isMobile" tooltip="导出会话为图片" placement="top" @click="handleExport">
            <span class="text-xl text-[#4f555e] dark:text-white">
              <SvgIcon icon="ri:download-2-line" />
            </span>
          </HoverButton>
          <HoverButton :tooltip="settingStore.agentMode ? 'Agent 模式：开（模型可自主调用工具）' : 'Agent 模式：关（纯对话）'" placement="top" @click="toggleAgentMode">
            <span class="text-xl" :class="{ 'text-[#0D9488]': settingStore.agentMode, 'text-[#4f555e] dark:text-white': !settingStore.agentMode }">
              <SvgIcon icon="ri:robot-2-line" />
            </span>
          </HoverButton>
          <HoverButton :tooltip="usingContext ? '上下文记忆：开（携带历史消息）' : '上下文记忆：关（单轮对话）'" placement="top" @click="toggleUsingContext">
            <span class="text-xl" :class="{ 'text-[#4b9e5f]': usingContext, 'text-[#a8071a]': !usingContext }">
              <SvgIcon icon="ri:chat-history-line" />
            </span>
          </HoverButton>
          <HoverButton :tooltip="isRecording ? '停止语音输入' : '语音输入'" placement="top" @click="toggleRecording">
            <span
              class="text-xl"
              :class="{ 'text-[#ef4444]': isRecording, 'text-[#4f555e] dark:text-white': !isRecording }"
            >
              <SvgIcon :icon="isRecording ? 'ri:mic-off-line' : 'ri:mic-line'" />
            </span>
          </HoverButton>
          <NAutoComplete v-model:value="prompt" :options="searchOptions" :render-label="renderOption">
            <template #default="{ handleInput, handleBlur, handleFocus }">
              <NInput
                ref="inputRef" v-model:value="prompt" type="textarea" :placeholder="placeholder"
                :autosize="{ minRows: 1, maxRows: isMobile ? 4 : 8 }" @input="handleInput" @focus="handleFocus"
                @blur="handleBlur" @keypress="handleEnter"
              />
            </template>
          </NAutoComplete>
          <NButton type="primary" :disabled="buttonDisabled" @click="handleSubmit">
            <template #icon>
              <span class="dark:text-black">
                <SvgIcon icon="ri:send-plane-fill" />
              </span>
            </template>
          </NButton>
        </div>
      </div>
    </footer>
  </div>
</template>

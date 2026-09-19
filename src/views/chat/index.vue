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
import { fetchAgentProcess, fetchChatAPIProcess } from '@/api'
import { t } from '@/locales'

let controller = new AbortController()

const openLongReply = import.meta.env.VITE_GLOB_OPEN_LONG_REPLY === 'true'

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
const conversationList = computed(() => dataSources.value.filter(item => (!item.inversion && !!item.conversationOptions)))

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
dataSources.value.forEach((item, index) => {
  if (item.loading)
    updateChatSome(+uuid, index, { loading: false })
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

async function onConversation() {
  let message = prompt.value

  if (loading.value)
    return

  if (!message || message.trim() === '')
    return

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

  // Agent 模式：走 /agent-process，SSE 逐事件渲染；thought/tool_call/tool_result 汇入 agentSteps 由 ToolCallCard 展示
  const onAgentConversation = async () => {
    const agentSteps: Chat.AgentStep[] = []
    await fetchAgentProcess({
      prompt: message,
      systemMessage: settingStore.systemMessage,
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'thought') {
          agentSteps.push({ type: 'thought', content: event.content })
          updateChatSome(+uuid, dataSources.value.length - 1, { agentSteps: [...agentSteps] })
        }
        else if (event.type === 'tool_call') {
          agentSteps.push({ type: 'tool_call', id: event.id, name: event.name, arguments: event.arguments })
          updateChatSome(+uuid, dataSources.value.length - 1, { agentSteps: [...agentSteps] })
        }
        else if (event.type === 'tool_result') {
          agentSteps.push({ type: 'tool_result', id: event.id, name: event.name, content: event.content })
          updateChatSome(+uuid, dataSources.value.length - 1, { agentSteps: [...agentSteps] })
        }
        else if (event.type === 'answer') {
          updateChat(
            +uuid,
            dataSources.value.length - 1,
            {
              dateTime: new Date().toLocaleString(),
              text: event.content ?? '',
              inversion: false,
              error: false,
              loading: true,
              agentSteps: [...agentSteps],
              conversationOptions: null,
              requestOptions: { prompt: message, options: { ...options } },
            },
          )
          scrollToBottomIfAtBottom()
        }
        else if (event.type === 'error') {
          updateChatSome(
            +uuid,
            dataSources.value.length - 1,
            { text: `[Agent 错误] ${event.message ?? ''}`, error: true, loading: false },
          )
        }
      },
    })
    updateChatSome(+uuid, dataSources.value.length - 1, { loading: false })
  }

  try {
    if (settingStore.agentMode) {
      await onAgentConversation()
    }
    else {
      let lastText = ''
      const fetchChatAPIOnce = async () => {
        await fetchChatAPIProcess<Chat.ConversationResponse>({
          prompt: message,
          options,
          signal: controller.signal,
          onDownloadProgress: ({ event }) => {
            const xhr = event.target
            const { responseText } = xhr
            // Always process the final line
            const lastIndex = responseText.lastIndexOf('\n', responseText.length - 2)
            let chunk = responseText
            if (lastIndex !== -1)
              chunk = responseText.substring(lastIndex)
            try {
              const data = JSON.parse(chunk)
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

              if (openLongReply && data.detail.choices[0].finish_reason === 'length') {
                options.parentMessageId = data.id
                lastText = data.text
                message = ''
                return fetchChatAPIOnce()
              }

              scrollToBottomIfAtBottom()
            }
            catch (error) {
            //
            }
          },
        })
        updateChatSome(+uuid, dataSources.value.length - 1, { loading: false })
      }

      await fetchChatAPIOnce()
    }
  }
  catch (error: any) {
    const errorMessage = error?.message ?? t('common.wrong')

    if (error.message === 'canceled' || error?.name === 'AbortError') {
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

  controller = new AbortController()

  const { requestOptions } = dataSources.value[index]

  let message = requestOptions?.prompt ?? ''

  let options: Chat.ConversationRequest = {}

  if (requestOptions.options)
    options = { ...requestOptions.options }

  loading.value = true

  updateChat(
    +uuid,
    index,
    {
      dateTime: new Date().toLocaleString(),
      text: '',
      inversion: false,
      error: false,
      loading: true,
      conversationOptions: null,
      requestOptions: { prompt: message, options: { ...options } },
    },
  )

  try {
    let lastText = ''
    const fetchChatAPIOnce = async () => {
      await fetchChatAPIProcess<Chat.ConversationResponse>({
        prompt: message,
        options,
        signal: controller.signal,
        onDownloadProgress: ({ event }) => {
          const xhr = event.target
          const { responseText } = xhr
          // Always process the final line
          const lastIndex = responseText.lastIndexOf('\n', responseText.length - 2)
          let chunk = responseText
          if (lastIndex !== -1)
            chunk = responseText.substring(lastIndex)
          try {
            const data = JSON.parse(chunk)
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

            if (openLongReply && data.detail.choices[0].finish_reason === 'length') {
              options.parentMessageId = data.id
              lastText = data.text
              message = ''
              return fetchChatAPIOnce()
            }
          }
          catch (error) {
            //
          }
        },
      })
      updateChatSome(+uuid, index, { loading: false })
    }
    await fetchChatAPIOnce()
  }
  catch (error: any) {
    if (error.message === 'canceled') {
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
                  @regenerate="onRegenerate(index)" @delete="handleDelete(index)" @reply="handleReply"
                  @speak="speakText"
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

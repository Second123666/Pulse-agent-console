<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { NModal } from 'naive-ui'
import { useRouter } from 'vue-router'
import { commandPaletteVisible } from './state'
import type { MessageSearchHit } from '@/api'
import { fetchConversationSearch } from '@/api'
import { SvgIcon } from '@/components/common'
import { setPendingJump, useAppStore, useChatStore } from '@/store'

interface CommandItem {
  key: string
  label: string
  hint?: string
  icon: string
  /** 分组标题：同组连续排列，渲染时「与上一项不同」就打一个组头 */
  group: string
  /** 命中区间（下标相对 label），仅消息搜索结果有 */
  highlight?: { start: number; end: number }
  action: () => void
}

const GROUP_COMMAND = '命令'
const GROUP_CONVERSATION = '会话'
const GROUP_MESSAGE = '会话消息'

/** 面板最多展示多少项（含三个分组） */
const MAX_RESULTS = 12
/** 消息检索的防抖间隔：面板是边打边搜的，不防抖会每个按键打一次全表扫描 */
const SEARCH_DEBOUNCE_MS = 250

const router = useRouter()
const appStore = useAppStore()
const chatStore = useChatStore()

// 开关状态在 state.ts（模块作用域）：侧边栏的搜索入口也要能翻它
const visible = commandPaletteVisible
const keyword = ref('')
const activeIndex = ref(0)
const inputRef = ref<HTMLInputElement>()

/** 服务端返回的消息命中（命令与会话是本地过滤，只有这部分要联网） */
const messageHits = ref<CommandItem[]>([])
let searchTimer: ReturnType<typeof setTimeout> | undefined
/** 请求序号：快速连打时后发的请求可能先返回，靠它丢弃过期结果 */
let searchSeq = 0

const staticCommands = computed<CommandItem[]>(() => [
  {
    key: 'new-chat',
    label: '新建对话',
    hint: '开始一段新会话',
    icon: 'ri:add-line',
    group: GROUP_COMMAND,
    action: () => {
      chatStore.addHistory({ title: '新的聊天', uuid: Date.now(), isEdit: false })
      router.push({ name: 'Chat', params: { uuid: chatStore.active } })
    },
  },
  {
    key: 'toggle-theme',
    label: '切换明暗主题',
    hint: appStore.theme === 'dark' ? '当前：深色' : '当前：浅色',
    icon: 'ri:contrast-2-line',
    group: GROUP_COMMAND,
    action: () => appStore.setTheme(appStore.theme === 'dark' ? 'light' : 'dark'),
  },
  {
    key: 'clear-history',
    label: '清空全部会话',
    hint: '不可恢复',
    icon: 'ri:delete-bin-line',
    group: GROUP_COMMAND,
    action: () => chatStore.clearHistory(),
  },
])

const historyCommands = computed<CommandItem[]>(() =>
  chatStore.history.map(item => ({
    key: `history-${item.uuid}`,
    label: item.title,
    hint: '会话',
    icon: 'ri:message-3-line',
    group: GROUP_CONVERSATION,
    action: () => {
      chatStore.setActive(item.uuid)
      router.push({ name: 'Chat', params: { uuid: item.uuid } })
    },
  })),
)

/** 服务端命中 → 面板项。回车切到该会话并把「跳到第几条消息」交给 Chat 视图 */
function hitToCommand(hit: MessageSearchHit): CommandItem {
  return {
    key: `hit-${hit.conversationUuid}-${hit.messageIndex}`,
    label: hit.snippet,
    hint: hit.conversationTitle || '未命名会话',
    icon: hit.role === 'user' ? 'ri:user-line' : 'ri:robot-2-line',
    group: GROUP_MESSAGE,
    ...(hit.matchEnd > hit.matchStart ? { highlight: { start: hit.matchStart, end: hit.matchEnd } } : {}),
    action: () => {
      // setActive 内部会 push 路由，跳转目标必须等切过去之后再设：
      // 否则目标先于挂载存在，新视图读到的会是「上一次的」目标
      chatStore.setActive(hit.conversationUuid).then(() => {
        setPendingJump(hit.conversationUuid, hit.messageIndex)
      })
    },
  }
}

function scheduleSearch(kw: string) {
  if (searchTimer)
    clearTimeout(searchTimer)

  if (!kw) {
    searchSeq += 1
    messageHits.value = []
    return
  }

  const seq = ++searchSeq
  searchTimer = setTimeout(async () => {
    try {
      const { data } = await fetchConversationSearch(kw)
      if (seq !== searchSeq)
        return
      messageHits.value = data.hits.map(hitToCommand)
    }
    catch {
      // 检索失败不该让整个面板不可用：清掉消息分组，命令与会话照常
      if (seq === searchSeq)
        messageHits.value = []
    }
  }, SEARCH_DEBOUNCE_MS)
}

const filtered = computed<CommandItem[]>(() => {
  const kw = keyword.value.trim().toLowerCase()
  const local = [...staticCommands.value, ...historyCommands.value]
  if (!kw)
    return local.slice(0, MAX_RESULTS)
  // 命令与会话按标题本地过滤；消息命中已由服务端按正文检索过，不再二次过滤
  const matched = local.filter(item => item.label.toLowerCase().includes(kw))
  return [...matched, ...messageHits.value].slice(0, MAX_RESULTS)
})

/**
 * 开关的收尾统一挂在这个 watch 上，而不是散在 open() / close() 里。
 *
 * 快捷键、侧边栏的搜索入口、遮罩点击都只翻 ref，于是三者走同一套语义 ——
 * 否则从侧边栏打开时不会清关键字、不会聚焦输入框，遮罩关闭时也不会作废在途检索
 * （此前正是漏的：遮罩关闭绕过了 close()）。
 */
watch(visible, (value) => {
  if (value) {
    keyword.value = ''
    activeIndex.value = 0
    nextTick(() => inputRef.value?.focus())
  }
  else {
    // 作废在途检索：关掉面板后返回的结果不该回填进来
    searchSeq += 1
    messageHits.value = []
  }
})

function open() {
  visible.value = true
}

function close() {
  visible.value = false
}

function run(item: CommandItem | undefined) {
  if (!item)
    return
  close()
  item.action()
}

function handleGlobalKeydown(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    visible.value ? close() : open()
  }
}

function handlePanelKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    activeIndex.value = Math.min(activeIndex.value + 1, filtered.value.length - 1)
  }
  else if (event.key === 'ArrowUp') {
    event.preventDefault()
    activeIndex.value = Math.max(activeIndex.value - 1, 0)
  }
  else if (event.key === 'Enter') {
    event.preventDefault()
    run(filtered.value[activeIndex.value])
  }
  else if (event.key === 'Escape') {
    close()
  }
}

watch(filtered, () => {
  activeIndex.value = 0
})

watch(keyword, (value) => {
  scheduleSearch(value.trim())
})

onMounted(() => window.addEventListener('keydown', handleGlobalKeydown))
onUnmounted(() => {
  window.removeEventListener('keydown', handleGlobalKeydown)
  if (searchTimer)
    clearTimeout(searchTimer)
})
</script>

<template>
  <NModal v-model:show="visible" :mask-closable="true" :auto-focus="false">
    <div
      class="command-palette w-[min(560px,90vw)] overflow-hidden rounded-xl border border-[var(--agent-hairline)] bg-[var(--agent-surface)] shadow-2xl"
      @keydown="handlePanelKeydown"
    >
      <div class="flex items-center gap-2 border-b border-[var(--agent-hairline)] px-4 py-3">
        <SvgIcon icon="ri:command-line" class="text-[var(--agent-accent)]" />
        <input
          ref="inputRef" v-model="keyword" type="text" placeholder="搜索会话、消息或输入命令…"
          class="w-full bg-transparent text-sm outline-none placeholder:text-[var(--agent-text-dim)]"
        >
        <kbd class="rounded border border-[var(--agent-hairline)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--agent-text-dim)]">
          esc
        </kbd>
      </div>
      <ul class="max-h-[320px] overflow-y-auto p-2">
        <template v-for="(item, i) of filtered" :key="item.key">
          <li
            v-if="i === 0 || filtered[i - 1].group !== item.group"
            class="px-3 pt-3 pb-1 text-[10px] font-mono tracking-wider uppercase text-[var(--agent-text-dim)]"
          >
            {{ item.group }}
          </li>
          <li
            class="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors"
            :class="i === activeIndex ? 'bg-[var(--agent-accent-soft)] text-[var(--agent-accent-pressed)] dark:text-[var(--agent-accent)]' : ''"
            @click="run(item)" @mouseenter="activeIndex = i"
          >
            <SvgIcon :icon="item.icon" class="shrink-0 opacity-70" />
            <span class="flex-1 truncate">
              <!-- 命中词高亮：用三段文本而非 v-html，正文内容不进 HTML 解析 -->
              <template v-if="item.highlight">
                <span>{{ item.label.slice(0, item.highlight.start) }}</span>
                <mark class="bg-transparent font-medium text-[var(--agent-accent)]">{{ item.label.slice(item.highlight.start, item.highlight.end) }}</mark>
                <span>{{ item.label.slice(item.highlight.end) }}</span>
              </template>
              <template v-else>{{ item.label }}</template>
            </span>
            <span v-if="item.hint" class="max-w-[40%] shrink-0 truncate text-[11px] font-mono text-[var(--agent-text-dim)]">{{ item.hint }}</span>
          </li>
        </template>
        <li v-if="!filtered.length" class="px-3 py-6 text-center text-sm text-[var(--agent-text-dim)]">
          没有匹配的命令、会话或消息
        </li>
      </ul>
    </div>
  </NModal>
</template>

<style scoped>
.command-palette {
  animation: palette-in 160ms cubic-bezier(0.22, 1, 0.36, 1);
}

@keyframes palette-in {
  from {
    opacity: 0;
    transform: translateY(-8px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .command-palette {
    animation: none;
  }
}
</style>

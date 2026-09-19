<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { NModal } from 'naive-ui'
import { useRouter } from 'vue-router'
import { SvgIcon } from '@/components/common'
import { useAppStore, useChatStore } from '@/store'

interface CommandItem {
  key: string
  label: string
  hint?: string
  icon: string
  action: () => void
}

const router = useRouter()
const appStore = useAppStore()
const chatStore = useChatStore()

const visible = ref(false)
const keyword = ref('')
const activeIndex = ref(0)
const inputRef = ref<HTMLInputElement>()

const staticCommands = computed<CommandItem[]>(() => [
  {
    key: 'new-chat',
    label: '新建对话',
    hint: '开始一段新会话',
    icon: 'ri:add-line',
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
    action: () => appStore.setTheme(appStore.theme === 'dark' ? 'light' : 'dark'),
  },
  {
    key: 'clear-history',
    label: '清空全部会话',
    hint: '不可恢复',
    icon: 'ri:delete-bin-line',
    action: () => chatStore.clearHistory(),
  },
])

const historyCommands = computed<CommandItem[]>(() =>
  chatStore.history.map(item => ({
    key: `history-${item.uuid}`,
    label: item.title,
    hint: '会话',
    icon: 'ri:message-3-line',
    action: () => {
      chatStore.setActive(item.uuid)
      router.push({ name: 'Chat', params: { uuid: item.uuid } })
    },
  })),
)

const filtered = computed<CommandItem[]>(() => {
  const kw = keyword.value.trim().toLowerCase()
  const all = [...staticCommands.value, ...historyCommands.value]
  if (!kw)
    return all.slice(0, 9)
  return all.filter(item => item.label.toLowerCase().includes(kw)).slice(0, 9)
})

function open() {
  visible.value = true
  keyword.value = ''
  activeIndex.value = 0
  nextTick(() => inputRef.value?.focus())
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

onMounted(() => window.addEventListener('keydown', handleGlobalKeydown))
onUnmounted(() => window.removeEventListener('keydown', handleGlobalKeydown))
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
          ref="inputRef" v-model="keyword" type="text" placeholder="搜索会话或输入命令…"
          class="w-full bg-transparent text-sm outline-none placeholder:text-[var(--agent-text-dim)]"
        >
        <kbd class="rounded border border-[var(--agent-hairline)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--agent-text-dim)]">
          esc
        </kbd>
      </div>
      <ul class="max-h-[320px] overflow-y-auto p-2">
        <li
          v-for="(item, i) of filtered" :key="item.key"
          class="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors"
          :class="i === activeIndex ? 'bg-[var(--agent-accent-soft)] text-[var(--agent-accent-pressed)] dark:text-[var(--agent-accent)]' : ''"
          @click="run(item)" @mouseenter="activeIndex = i"
        >
          <SvgIcon :icon="item.icon" class="shrink-0 opacity-70" />
          <span class="flex-1 truncate">{{ item.label }}</span>
          <span v-if="item.hint" class="text-[11px] font-mono text-[var(--agent-text-dim)]">{{ item.hint }}</span>
        </li>
        <li v-if="!filtered.length" class="px-3 py-6 text-center text-sm text-[var(--agent-text-dim)]">
          没有匹配的命令或会话
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

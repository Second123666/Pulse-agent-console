<script lang="ts" setup>
import { computed } from 'vue'
import { NDropdown, NSwitch } from 'naive-ui'
import { HoverButton, SvgIcon } from '@/components/common'
import { useAppStore, useChatStore, useSettingStore } from '@/store'

interface Props {
  usingContext: boolean
}

interface Emit {
  (ev: 'export', format: 'markdown' | 'plain'): void
  (ev: 'handleClear'): void
  /** 双击标题回顶（14.1）：滚动容器归 Chat 视图的虚拟列表管，这里只发意图 */
  (ev: 'scrollTop'): void
}

defineProps<Props>()

const emit = defineEmits<Emit>()

const appStore = useAppStore()
const chatStore = useChatStore()
const settingStore = useSettingStore()

const collapsed = computed(() => appStore.siderCollapsed)
const currentChatHistory = computed(() => chatStore.getChatHistoryByCurrentActive)

function handleUpdateCollapsed() {
  appStore.setSiderCollapsed(!collapsed.value)
}

function onScrollToTop() {
  emit('scrollTop')
}

/** 导出格式选项（与桌面端一致；文案硬编码，不新增 i18n 键） */
const exportOptions = [
  { label: 'Markdown', key: 'markdown' },
  { label: '纯文本', key: 'plain' },
]

/** 导出交给 Chat 视图做 —— 只有那里有 dataSources 与路由 uuid */
function handleExport(key: string | number) {
  emit('export', key === 'plain' ? 'plain' : 'markdown')
}

function handleClear() {
  emit('handleClear')
}

function handleAgentModeChange(value: boolean) {
  settingStore.updateSetting({ agentMode: value })
}
</script>

<template>
  <header
    class="sticky top-0 left-0 right-0 z-30 border-b dark:border-neutral-800 bg-white/80 dark:bg-black/20 backdrop-blur"
  >
    <div class="relative flex items-center justify-between min-w-0 overflow-hidden h-14">
      <div class="flex items-center">
        <button
          class="flex items-center justify-center w-11 h-11"
          @click="handleUpdateCollapsed"
        >
          <SvgIcon v-if="collapsed" class="text-2xl" icon="ri:align-justify" />
          <SvgIcon v-else class="text-2xl" icon="ri:align-right" />
        </button>
      </div>
      <h1
        class="flex-1 px-4 pr-6 overflow-hidden cursor-pointer select-none text-ellipsis whitespace-nowrap"
        @dblclick="onScrollToTop"
      >
        {{ currentChatHistory?.title ?? '' }}
      </h1>
      <div class="flex items-center space-x-2">
        <div class="flex items-center gap-1.5 select-none" title="Agent 模式：开启后由 Agent 循环处理（支持工具调用）">
          <span class="text-xs text-[#4f555e] dark:text-neutral-400">Agent</span>
          <NSwitch size="small" :value="settingStore.agentMode" @update:value="handleAgentModeChange" />
        </div>
        <NDropdown :options="exportOptions" trigger="click" @select="handleExport">
          <span class="inline-flex">
            <HoverButton>
              <span class="text-xl text-[#4f555e] dark:text-white">
                <SvgIcon icon="ri:download-2-line" />
              </span>
            </HoverButton>
          </span>
        </NDropdown>
        <HoverButton @click="handleClear">
          <span class="text-xl text-[#4f555e] dark:text-white">
            <SvgIcon icon="ri:delete-bin-line" />
          </span>
        </HoverButton>
      </div>
    </div>
  </header>
</template>

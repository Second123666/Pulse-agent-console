<script setup lang='ts'>
import type { CSSProperties } from 'vue'
import { computed, watch } from 'vue'
import { NButton, NLayoutSider, useDialog } from 'naive-ui'
import List from './List.vue'
import Footer from './Footer.vue'
import { useAppStore, useChatStore } from '@/store'
import { useBasicLayout } from '@/hooks/useBasicLayout'
import { BrandLogo, SvgIcon } from '@/components/common'
import { openCommandPalette } from '@/components/common/CommandPalette/state'
import { t } from '@/locales'

const appStore = useAppStore()
const chatStore = useChatStore()

const dialog = useDialog()

const { isMobile } = useBasicLayout()

const collapsed = computed(() => appStore.siderCollapsed)

function handleAdd() {
  chatStore.addHistory({ title: t('chat.newChatTitle'), uuid: Date.now(), isEdit: false })
  if (isMobile.value)
    appStore.setSiderCollapsed(true)
}

/** Mac 上显示 ⌘K，其余平台显示 Ctrl K（两种修饰键面板都认，见 CommandPalette 的 handleGlobalKeydown） */
const shortcutHint = /mac/i.test(navigator.userAgent) ? '⌘K' : 'Ctrl K'

/** 打开命令面板（搜索会话与消息）。面板此前只有 Ctrl+K 一个入口，不按快捷键就发现不了 */
function handleSearch() {
  openCommandPalette()
  // 移动端侧边栏是覆盖层：顺手收起，别挡着刚打开的面板
  if (isMobile.value)
    appStore.setSiderCollapsed(true)
}

function handleUpdateCollapsed() {
  appStore.setSiderCollapsed(!collapsed.value)
}

function handleClearAll() {
  dialog.warning({
    title: t('chat.deleteMessage'),
    content: t('chat.clearHistoryConfirm'),
    positiveText: t('common.yes'),
    negativeText: t('common.no'),
    onPositiveClick: () => {
      chatStore.clearHistory()
      if (isMobile.value)
        appStore.setSiderCollapsed(true)
    },
  })
}

const getMobileClass = computed<CSSProperties>(() => {
  if (isMobile.value) {
    return {
      position: 'fixed',
      zIndex: 50,
    }
  }
  return {}
})

const mobileSafeArea = computed(() => {
  if (isMobile.value) {
    return {
      paddingBottom: 'env(safe-area-inset-bottom)',
    }
  }
  return {}
})

watch(
  isMobile,
  (val) => {
    appStore.setSiderCollapsed(val)
  },
  {
    immediate: true,
    flush: 'post',
  },
)
</script>

<template>
  <NLayoutSider
    :collapsed="collapsed"
    :collapsed-width="0"
    :width="260"
    :show-trigger="isMobile ? false : 'arrow-circle'"
    collapse-mode="transform"
    position="absolute"
    bordered
    :style="getMobileClass"
    @update-collapsed="handleUpdateCollapsed"
  >
    <div class="flex flex-col h-full" :style="mobileSafeArea">
      <header class="flex items-center gap-2.5 px-4 pt-4 pb-1 select-none">
        <BrandLogo :size="28" />
        <div class="leading-tight">
          <div class="text-[15px] font-semibold tracking-wider pulse-brand">
            思脉AI工作台
          </div>
          <div class="text-[11px] text-[var(--agent-text-dim)] font-mono">
            pulse · agent console
          </div>
        </div>
      </header>
      <main class="flex flex-col flex-1 min-h-0">
        <div class="p-4">
          <NButton dashed block @click="handleAdd">
            {{ $t('chat.newChatButton') }}
          </NButton>
          <!-- 命令面板的可见入口：此前只有 Ctrl+K，不按快捷键就永远发现不了搜索功能 -->
          <button
            class="flex items-center w-full gap-2 px-3 py-2 mt-2 text-sm rounded-lg border border-[var(--agent-hairline)] text-[var(--agent-text-dim)] hover:border-[var(--agent-accent)] hover:text-[var(--agent-accent)] transition"
            @click="handleSearch"
          >
            <SvgIcon icon="ri:search-line" class="shrink-0" />
            <span class="flex-1 text-left truncate">搜索会话与消息</span>
            <kbd class="shrink-0 px-1.5 py-0.5 font-mono text-[10px] rounded border border-[var(--agent-hairline)]">{{ shortcutHint }}</kbd>
          </button>
        </div>
        <div class="flex-1 min-h-0 pb-4 overflow-hidden">
          <List />
        </div>
        <div class="flex items-center justify-end p-4">
          <NButton @click="handleClearAll">
            <SvgIcon icon="ri:close-circle-line" />
          </NButton>
        </div>
      </main>
      <Footer />
    </div>
  </NLayoutSider>
  <template v-if="isMobile">
    <div v-show="!collapsed" class="fixed inset-0 z-40 w-full h-full bg-black/40" @click="handleUpdateCollapsed" />
  </template>
</template>

<script setup lang='ts'>
import { computed, ref } from 'vue'
import { NDropdown, useMessage } from 'naive-ui'
import AvatarComponent from './Avatar.vue'
import TextComponent from './Text.vue'
import ToolCallCard from './ToolCallCard.vue'
import { SvgIcon } from '@/components/common'
import { useIconRender } from '@/hooks/useIconRender'
import { t } from '@/locales'
import { useBasicLayout } from '@/hooks/useBasicLayout'
import { copyToClip } from '@/utils/copy'

interface Props {
  dateTime?: string
  text?: string
  inversion?: boolean
  error?: boolean
  loading?: boolean
  agentSteps?: Chat.AgentStep[]
  /** Agent 连接静默超时：显示「连接可能已中断」+ 手动重试 */
  agentStalled?: boolean
  /** 本轮的 token 用量与耗时（仅 Agent 模式） */
  usage?: Chat.AgentUsage
  /**
   * 本条消息附带的图片（13.3）。元素要么是缩略图 data URL，
   * 要么是落库时体积超限留下的文字占位 —— 模板按前缀分辨
   */
  images?: string[]
  /** 会话搜索跳转过来时闪一下，帮用户在同屏多条消息里定位命中项 */
  highlighted?: boolean
}

interface Emit {
  (ev: 'regenerate'): void
  /** 停滞横幅上的「重试」：优先续传补齐缺口，续不上才整轮重发（与 regenerate 区分开） */
  (ev: 'retry'): void
  (ev: 'delete'): void
  (ev: 'reply', text: string): void
  (ev: 'speak', text: string): void
  /** 工具审批决策（id = toolCallId，approved 为用户的决定） */
  (ev: 'approve', id: string, approved: boolean): void
}

const props = defineProps<Props>()

const emit = defineEmits<Emit>()

const { isMobile } = useBasicLayout()

const { iconRender } = useIconRender()

const message = useMessage()

const textRef = ref<HTMLElement>()

/** 附件渲染项：「是图还是文字占位」在这里算好，模板里不再重复做前缀判断 */
const imageItems = computed(() => (props.images ?? []).map((src, index) => ({
  key: index,
  isImage: src.startsWith('data:image'),
  src,
})))

const asRawText = ref(props.inversion)

const messageRef = ref<HTMLElement>()

const options = computed(() => {
  const common = [
    {
      label: t('chat.speak'),
      key: 'speak',
      icon: iconRender({ icon: 'ri:volume-up-line' }),
    },
    {
      label: t('chat.reply'),
      key: 'reply',
      icon: iconRender({ icon: 'ri:reply-line' }),
    },
    {
      label: t('chat.copy'),
      key: 'copyText',
      icon: iconRender({ icon: 'ri:file-copy-2-line' }),
    },
    {
      label: t('common.delete'),
      key: 'delete',
      icon: iconRender({ icon: 'ri:delete-bin-line' }),
    },
  ]

  if (!props.inversion) {
    common.unshift({
      label: asRawText.value ? t('chat.preview') : t('chat.showRawText'),
      key: 'toggleRenderType',
      icon: iconRender({ icon: asRawText.value ? 'ic:outline-code-off' : 'ic:outline-code' }),
    })
  }

  return common
})

function handleSelect(key: 'speak' | 'reply' | 'copyText' | 'delete' | 'toggleRenderType') {
  switch (key) {
    case 'speak':
      emit('speak', props.text || '')
      return
    case 'reply':
      emit('reply', props.text || '')
      return
    case 'copyText':
      handleCopy()
      return
    case 'toggleRenderType':
      asRawText.value = !asRawText.value
      return
    case 'delete':
      emit('delete')
  }
}

function handleRegenerate() {
  messageRef.value?.scrollIntoView()
  emit('regenerate')
}

/** 停滞横幅的重试：语义比「重新生成」弱 —— 已有内容会被保留，只补断线期间漏掉的部分 */
function handleRetry() {
  messageRef.value?.scrollIntoView()
  emit('retry')
}

/** token 数简写：1234 → 1.2k（不足 1000 原样） */
function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0)
    return '0'
  return value < 1000 ? String(Math.round(value)) : `${(value / 1000).toFixed(1)}k`
}

/** 耗时简写：4300 → 4.3s（不足 1 秒显示毫秒） */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0)
    return '0s'
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

async function handleCopy() {
  try {
    await copyToClip(props.text || '')
    message.success(t('chat.copied'))
  }
  catch {
    message.error(t('chat.copyFailed'))
  }
}
</script>

<template>
  <div
    ref="messageRef" class="flex w-full mb-6 overflow-hidden rounded-lg"
    :class="[{ 'flex-row-reverse': inversion }, highlighted ? 'agent-message-flash' : '']"
  >
    <div
      class="flex items-center justify-center flex-shrink-0 h-8 overflow-hidden rounded-full basis-8"
      :class="[inversion ? 'ml-2' : 'mr-2']"
    >
      <AvatarComponent :image="inversion" />
    </div>
    <div class="overflow-hidden text-sm " :class="[inversion ? 'items-end' : 'items-start']">
      <p class="text-xs text-[#b4bbc4]" :class="[inversion ? 'text-right' : 'text-left']">
        {{ dateTime }}
      </p>
      <div class="flex items-end gap-1 mt-2" :class="[inversion ? 'flex-row-reverse' : 'flex-row']">
        <div class="flex flex-col">
          <!-- 附件图片：直接 <img> 渲染，**不进 markdown** —— Text.vue 的 `html: false` 是 XSS 面，一个字都不动 -->
          <div
            v-if="imageItems.length"
            class="flex flex-wrap gap-2 mb-1"
            :class="[inversion ? 'justify-end' : 'justify-start']"
          >
            <template v-for="item in imageItems" :key="item.key">
              <img
                v-if="item.isImage"
                :src="item.src" :alt="t('chat.imageAlt')"
                class="object-cover w-24 h-24 rounded-lg border border-[var(--agent-hairline)]"
              >
              <!-- 落库时体积超限的那几张：只留一行说明，不塞半张图 -->
              <span
                v-else
                class="flex items-center max-w-[16rem] px-2 py-1 text-xs rounded border border-[var(--agent-hairline)] text-[var(--agent-text-dim)]"
              >{{ item.src }}</span>
            </template>
          </div>
          <TextComponent
            ref="textRef" :inversion="inversion" :error="error" :text="text" :loading="loading"
            :as-raw-text="asRawText"
          />
          <ToolCallCard
            v-if="agentSteps?.length && !inversion" :steps="agentSteps" :interactive="!!loading"
            @approve="(id, approved) => emit('approve', id, approved)"
          />
          <!-- 用量：等宽小字，低调到不抢正文视线。历史消息（含从服务端水合回来的）同样显示 -->
          <div
            v-if="usage && !inversion"
            class="mt-1 font-mono text-[11px] text-[var(--agent-text-dim)] select-none"
          >
            {{ formatTokens(usage.promptTokens) }} in · {{ formatTokens(usage.completionTokens) }} out · {{ formatDuration(usage.durationMs) }}
          </div>
          <div
            v-if="agentStalled && !inversion"
            class="flex items-center gap-3 mt-2 px-3 py-2 text-xs rounded border border-amber-300 text-amber-700 bg-amber-50 dark:bg-amber-900/20 dark:text-amber-300 dark:border-amber-700"
          >
            <span>本轮未能完成（连接中断，或服务端已停止运行）</span>
            <button
              class="px-2 py-0.5 rounded border border-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/40 transition"
              @click="handleRetry"
            >
              继续
            </button>
          </div>
        </div>
        <div class="flex flex-col">
          <button
            v-if="!inversion"
            class="mb-2 transition text-neutral-300 hover:text-neutral-800 dark:hover:text-neutral-300"
            @click="handleRegenerate"
          >
            <SvgIcon icon="ri:restart-line" />
          </button>
          <NDropdown
            :trigger="isMobile ? 'click' : 'hover'" :placement="!inversion ? 'right' : 'left'"
            :options="options" @select="handleSelect"
          >
            <button class="transition text-neutral-300 hover:text-neutral-800 dark:hover:text-neutral-200">
              <SvgIcon icon="ri:more-2-fill" />
            </button>
          </NDropdown>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 会话搜索跳转后的定位提示：左侧一道强调色 + 淡底，闪完自行消失（不留持久样式） */
.agent-message-flash {
  animation: message-flash 2.4s ease-out;
}

@keyframes message-flash {
  0% {
    background-color: var(--agent-accent-soft);
    box-shadow: inset 3px 0 0 var(--agent-accent);
  }
  60% {
    background-color: var(--agent-accent-soft);
    box-shadow: inset 3px 0 0 var(--agent-accent);
  }
  100% {
    background-color: transparent;
    box-shadow: inset 3px 0 0 transparent;
  }
}

@media (prefers-reduced-motion: reduce) {
  .agent-message-flash {
    animation: none;
    background-color: var(--agent-accent-soft);
    box-shadow: inset 3px 0 0 var(--agent-accent);
  }
}
</style>

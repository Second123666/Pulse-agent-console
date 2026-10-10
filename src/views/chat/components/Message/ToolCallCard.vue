<script setup lang="ts">
// 控制台步骤流样式：等宽字体 + ▎思考 / ├─▸工具，与 Pulse 品牌一致
type AgentStep = Chat.AgentStep

defineProps<{
  steps: AgentStep[]
  /** 是否可交互（仅运行中的消息为真）：历史消息里的审批卡片只做只读回放，不给按钮 */
  interactive?: boolean
}>()

const emit = defineEmits<{ (ev: 'approve', id: string, approved: boolean): void }>()

function formatArgs(args?: string): string {
  if (!args)
    return ''
  try {
    return JSON.stringify(JSON.parse(args), null, 2)
  }
  catch {
    return args
  }
}

function handleApprove(id: string | undefined, approved: boolean) {
  if (!id)
    return
  emit('approve', id, approved)
}
</script>

<template>
  <div class="agent-steps mt-2 font-mono text-xs leading-relaxed text-[#4f555e] dark:text-neutral-400">
    <div
      v-for="(step, index) in steps" :key="index"
      class="border-b border-neutral-100 last:border-b-0 dark:border-neutral-800 py-1.5"
    >
      <!-- 思考：浅色小字内联展示 -->
      <div v-if="step.type === 'thought'">
        <div class="flex items-center gap-1.5 text-[#8a8f98] dark:text-neutral-500">
          <span class="text-[#0D9488]">▎</span>思考
        </div>
        <div class="mt-0.5 pl-3.5 text-[#8a8f98] dark:text-neutral-500">
          {{ step.content }}
        </div>
      </div>
      <!-- 工具调用：折叠展示名称 + 参数 JSON -->
      <div v-else-if="step.type === 'tool_call'">
        <details class="group">
          <summary
            class="flex items-center gap-1.5 cursor-pointer list-none select-none hover:text-[#0D9488] dark:hover:text-[#2DD4BF]"
          >
            <span class="text-[#0D9488] dark:text-[#2DD4BF]">├─▸</span>
            <span>工具：{{ step.name }}</span>
            <span v-if="step.id" class="text-neutral-300 dark:text-neutral-600">{{ step.id.slice(0, 8) }}</span>
            <span class="ml-auto text-neutral-300 group-open:hidden dark:text-neutral-600">▸</span>
            <span class="hidden ml-auto text-neutral-300 group-open:inline dark:text-neutral-600">▾</span>
          </summary>
          <pre class="mt-1 pl-3.5 whitespace-pre-wrap break-all">{{ formatArgs(step.arguments) }}</pre>
        </details>
      </div>
      <!-- 工具审批（human-in-the-loop）：理由 + 允许/拒绝，决策后落定为已决策态 -->
      <div v-else-if="step.type === 'tool_approval'">
        <div class="flex items-center gap-1.5">
          <span class="text-amber-500 dark:text-amber-400">├─⚠</span>
          <span>审批：{{ step.name }}</span>
          <span v-if="step.id" class="text-neutral-300 dark:text-neutral-600">{{ step.id.slice(0, 8) }}</span>
          <span v-if="step.approved === true" class="ml-auto text-[#0D9488] dark:text-[#2DD4BF]">✓ 已允许</span>
          <span v-else-if="step.approved === false" class="ml-auto text-[#a8071a] dark:text-[#ff7875]">✕ 已拒绝</span>
          <span v-else class="ml-auto text-amber-600 dark:text-amber-400">待决策</span>
        </div>
        <div class="mt-1 pl-3.5">
          <div v-if="step.reason" class="text-amber-700 dark:text-amber-300">
            理由：{{ step.reason }}
          </div>
          <pre v-if="step.arguments" class="mt-1 whitespace-pre-wrap break-all">{{ formatArgs(step.arguments) }}</pre>
          <div v-if="step.approved === undefined" class="flex items-center gap-2 mt-1.5">
            <template v-if="interactive">
              <button
                class="px-2 py-0.5 rounded border border-[#0D9488] text-[#0D9488] hover:bg-[#0D9488]/10 dark:text-[#2DD4BF] dark:border-[#2DD4BF] transition"
                @click="handleApprove(step.id, true)"
              >
                允许
              </button>
              <button
                class="px-2 py-0.5 rounded border border-[#a8071a] text-[#a8071a] hover:bg-[#a8071a]/10 dark:text-[#ff7875] dark:border-[#ff7875] transition"
                @click="handleApprove(step.id, false)"
              >
                拒绝
              </button>
              <span class="text-neutral-400 dark:text-neutral-500">60 秒未决策将自动拒绝</span>
            </template>
            <span v-else class="text-neutral-400 dark:text-neutral-500">未决策</span>
          </div>
        </div>
      </div>
      <!-- 工具结果：折叠展示 -->
      <div v-else>
        <details class="group">
          <summary
            class="flex items-center gap-1.5 cursor-pointer list-none select-none hover:text-[#0D9488] dark:hover:text-[#2DD4BF]"
          >
            <span class="text-[#0D9488] dark:text-[#2DD4BF]">├─▸</span>
            <span>结果：{{ step.name }}</span>
            <span class="ml-auto text-neutral-300 group-open:hidden dark:text-neutral-600">▸</span>
            <span class="hidden ml-auto text-neutral-300 group-open:inline dark:text-neutral-600">▾</span>
          </summary>
          <div class="mt-1 pl-3.5 whitespace-pre-wrap break-all">
            {{ step.content }}
          </div>
        </details>
      </div>
    </div>
  </div>
</template>

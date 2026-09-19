<script setup lang="ts">
// 控制台步骤流样式：等宽字体 + ▎思考 / ├─▸工具，与 Pulse 品牌一致
type AgentStep = Chat.AgentStep

defineProps<{ steps: AgentStep[] }>()

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

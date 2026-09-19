<script setup lang="ts">
import { BrandLogo, SvgIcon } from '@/components/common'

interface Emit {
  (ev: 'select', prompt: string): void
}

const emit = defineEmits<Emit>()

const examples = [
  {
    icon: 'ri:tools-line',
    title: '工具体验',
    prompt: '现在几点？再算算 100 天后是几号',
    hint: '触发 get_time + calculator 多步调用',
  },
  {
    icon: 'ri:search-eye-line',
    title: '联网检索',
    prompt: '帮我搜一下今天的热点新闻并总结三条',
    hint: '触发 web_search 工具',
  },
  {
    icon: 'ri:book-read-line',
    title: '知识库问答',
    prompt: '根据知识库回答：这个项目的技术架构是什么？',
    hint: '触发 rag_search 检索增强',
  },
]
</script>

<template>
  <div class="flex flex-col items-center px-6 pt-10 pb-6 select-none empty-state">
    <div class="empty-state-hero flex flex-col items-center">
      <BrandLogo :size="56" />
      <h1 class="mt-4 text-2xl font-semibold tracking-wider pulse-brand">
        思脉AI工作台
      </h1>
      <p class="mt-1.5 text-[13px] font-mono text-[var(--agent-text-dim)]">
        an agent that thinks, calls tools &amp; answers
      </p>
    </div>

    <div class="grid w-full max-w-xl gap-3 mt-10 sm:grid-cols-3">
      <button
        v-for="(item, i) in examples" :key="item.title"
        class="empty-card group flex flex-col items-start gap-2 rounded-xl border border-[var(--agent-hairline)] bg-[var(--agent-surface)] p-4 text-left transition-all duration-150 hover:border-[var(--agent-accent)] hover:shadow-sm"
        :style="{ transitionDelay: `${i * 20}ms` }"
        @click="emit('select', item.prompt)"
      >
        <span class="text-lg text-[var(--agent-accent)]">
          <SvgIcon :icon="item.icon" />
        </span>
        <span class="text-sm font-medium">{{ item.title }}</span>
        <span class="text-xs leading-relaxed text-[var(--agent-text-dim)]">{{ item.prompt }}</span>
        <span class="mt-auto pt-1 text-[11px] font-mono text-[var(--agent-text-dim)] opacity-0 transition-opacity group-hover:opacity-100">
          ▸ {{ item.hint }}
        </span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.empty-state-hero {
  animation: hero-in 400ms cubic-bezier(0.22, 1, 0.36, 1);
}

.empty-card {
  animation: card-in 360ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
}

.empty-card:nth-child(1) { animation-delay: 120ms; }
.empty-card:nth-child(2) { animation-delay: 200ms; }
.empty-card:nth-child(3) { animation-delay: 280ms; }

@keyframes hero-in {
  from {
    opacity: 0;
    transform: translateY(10px) scale(0.97);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes card-in {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .empty-state-hero,
  .empty-card {
    animation: none;
  }
}
</style>

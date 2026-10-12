<script setup lang="ts">
import { computed } from 'vue'

interface Props {
  /** 信号失效的方式：lost=路径断在半空 / blocked=撞上闸门 / overload=过载后崩塌 */
  variant: 'lost' | 'blocked' | 'overload'
  /** 错误码，等宽字体显示在场景下方 */
  code?: string
  /** 一句话说明，跟在错误码之后 */
  caption?: string
}

const props = defineProps<Props>()

/**
 * 三个变体共用同一条「脉搏」信号的开头（与登录页仪表、背景素材里的 ECG 同源），
 * 区别只在它怎么失败 —— 这样三张错误页看起来是同一个信号系统的三种故障。
 */
const TRACE: Record<Props['variant'], string> = {
  lost: 'M0 80 H24 L32 52 L44 108 L52 80 H96 L104 60 L116 100 L124 80 H152 L160 68 L168 58',
  blocked: 'M0 80 H24 L32 52 L44 108 L52 80 H96 L104 60 L116 100 L124 80 H170',
  overload: 'M0 80 H16 L22 66 L28 94 L34 58 L40 102 L46 50 L52 108 L58 44 L64 114 L70 54 L76 104 L82 46 L88 110 L94 62 L100 92 L106 70 L112 86 L118 76 L124 82 L130 78 L136 80',
}

const trace = computed(() => TRACE[props.variant])

const ariaLabel = computed(() => ({
  lost: '信号中断：轨迹升到半空后停止，没有去向',
  blocked: '信号被拦截：轨迹撞上闸门后停止',
  overload: '信号过载：轨迹剧烈抖动后归于平直',
}[props.variant]))
</script>

<template>
  <figure class="signal-scene w-full max-w-[440px] m-auto">
    <svg
      viewBox="0 0 360 140" class="w-full h-auto" fill="none"
      role="img" :aria-label="ariaLabel" xmlns="http://www.w3.org/2000/svg"
    >
      <!-- 基线：安静的示波器中心线 -->
      <line
        x1="0" y1="80" x2="360" y2="80" stroke="var(--agent-hairline)"
        stroke-width="1" stroke-dasharray="2 6"
      />

      <!-- 过载变体：崩塌之后信号已死，尾巴用弱色表示 -->
      <path
        v-if="variant === 'overload'" d="M136 80 H360" stroke="var(--agent-text-dim)"
        stroke-width="2.5" stroke-linecap="round" opacity="0.45"
      />

      <!-- 主轨迹：进场时逐段画出 -->
      <path
        :d="trace" class="signal-scene__trace" pathLength="1" stroke="var(--agent-accent)"
        stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
      />

      <!-- 各变体的故障标记 -->
      <template v-if="variant === 'lost'">
        <!-- 断点：轨迹停在这里，没有下一段 -->
        <circle class="signal-scene__mark" cx="168" cy="58" r="3.5" fill="var(--signal-fault)" />
      </template>

      <template v-else-if="variant === 'blocked'">
        <!-- 闸门：双竖线，信号停在它前面 -->
        <line
          class="signal-scene__mark" x1="176" y1="40" x2="176" y2="120"
          stroke="var(--signal-fault)" stroke-width="2.5" stroke-linecap="round"
        />
        <line
          class="signal-scene__mark" x1="185" y1="54" x2="185" y2="106"
          stroke="var(--signal-fault)" stroke-width="1.5" stroke-linecap="round" opacity="0.45"
        />
      </template>

      <template v-else>
        <!-- 崩塌点：抖动结束的那一下 -->
        <circle class="signal-scene__mark" cx="136" cy="80" r="3" fill="var(--signal-fault)" />
      </template>
    </svg>

    <figcaption v-if="code || caption" class="mt-4 font-mono text-[13px] text-[var(--agent-text-dim)]">
      <span v-if="code" class="text-[var(--agent-accent)]">{{ code }}</span>
      <span v-if="code && caption" class="mx-1.5">·</span>
      <span v-if="caption">{{ caption }}</span>
    </figcaption>
  </figure>
</template>

<style scoped lang="less">
.signal-scene {
  // 故障色只属于这个场景，不进全局令牌：它表达的是「信号异常」这一个语义
  --signal-fault: #d97706;

  &__trace {
    stroke-dasharray: 1;
    stroke-dashoffset: 1;
    animation: signal-draw 900ms cubic-bezier(0.22, 0.61, 0.36, 1) forwards;
  }

  &__mark {
    opacity: 0;
    animation: signal-mark 320ms ease-out 780ms forwards;
  }
}

html.dark .signal-scene {
  --signal-fault: #fbbf24;
}

@keyframes signal-draw {
  to {
    stroke-dashoffset: 0;
  }
}

@keyframes signal-mark {
  to {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .signal-scene__trace {
    animation: none;
    stroke-dashoffset: 0;
  }

  .signal-scene__mark {
    animation: none;
    opacity: 1;
  }
}
</style>

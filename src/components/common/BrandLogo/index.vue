<script setup lang="ts">
// 品牌标：品牌青渐变圆角方块 + 白色外星人头像。
// 母版是 src/assets/brand-mark.png（512×512），favicon / PWA 图标都由它缩出来 ——
// 换标时改这一个文件（见 PROGRESS 里记录的那条 PIL 生成命令），别只改这里。
import brandMark from '@/assets/brand-mark.png'

interface Props {
  size?: number
  /**
   * tile=圆角方块（母版原样，用于品牌位）；
   * circle=圆形（用于头像位）—— 头像容器是 32px 的圆形遮罩，28px 方块的四个角
   * 落在圆外会被切掉，所以这里主动裁成圆，形状与遮罩对齐
   */
  shape?: 'tile' | 'circle'
}

withDefaults(defineProps<Props>(), { size: 28, shape: 'tile' })
</script>

<template>
  <img
    :src="brandMark" :width="size" :height="size" alt=""
    role="img" aria-label="Pulse logo" class="brand-logo" :class="`brand-logo--${shape}`"
  >
</template>

<style scoped>
/* 这个块是纯 CSS（没有 lang="less"）—— 嵌套 `&--x` 会被整段丢掉，别写嵌套 */
.brand-logo {
  display: block;
  flex: none; /* 在 flex 行里不被压扁 */
}

/* 与母版的 rx 同比例（25%）。母版 PNG 的角本来就烘了透明，这条是给
   缩放取整留的保险；真正离不开它的是下面的圆形形态 */
.brand-logo--tile {
  border-radius: 25%;
}

.brand-logo--circle {
  border-radius: 50%;
}
</style>

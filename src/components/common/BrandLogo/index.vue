<script setup lang="ts">
// 品牌标：品牌青渐变圆角方块 + 白色外星人头像。
// 母版是 src/assets/brand-mark.png（512×512），favicon / PWA 图标都由它缩出来 ——
// 换标时改这一个文件（见 PROGRESS 里记录的那条 PIL 生成命令），别只改这里。
import brandMark from '@/assets/brand-mark.png'

interface Props {
  size?: number
}

withDefaults(defineProps<Props>(), { size: 28 })
</script>

<template>
  <img
    :src="brandMark" :width="size" :height="size" alt=""
    role="img" aria-label="Pulse logo" class="brand-logo"
  >
</template>

<style scoped>
.brand-logo {
  display: block;
  flex: none; /* 在 flex 行里不被压扁 */
  /* 与母版的 rx 同比例（25%），缩放时的边缘更干净 */
  border-radius: 25%;
}
</style>

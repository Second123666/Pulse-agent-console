<script setup lang="ts">
interface Props {
  size?: number
}

withDefaults(defineProps<Props>(), { size: 28 })
</script>

<template>
  <svg
    :width="size" :height="size" viewBox="0 0 32 32" fill="none"
    xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Pulse logo"
  >
    <rect width="32" height="32" rx="8" fill="url(#pulse-bg)" />
    <path
      d="M6 16h4l2.5-6 4 12 3-8 1.8 2H26"
      stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"
    />
    <circle cx="26" cy="16" r="1.6" fill="#fff" />
    <defs>
      <linearGradient id="pulse-bg" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
        <stop stop-color="#14B8A6" />
        <stop offset="1" stop-color="#0F766E" />
      </linearGradient>
    </defs>
  </svg>
</template>

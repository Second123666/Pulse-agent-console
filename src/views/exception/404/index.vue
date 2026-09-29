<script lang="ts" setup>
import { NButton } from 'naive-ui'
import { useRouter } from 'vue-router'
import { SignalScene } from '@/components/common'

const router = useRouter()

function goHome() {
  router.push('/')
}
</script>

<template>
  <div class="flex h-full">
    <div class="px-4 m-auto space-y-5 text-center max-w-[400px]">
      <SignalScene variant="lost" code="404" caption="这个地址没有对应页面" />
      <p class="text-sm text-slate-500 dark:text-neutral-400">
        检查一下链接是否拼错，或者回到工作台重新开始。
      </p>
      <NButton type="primary" @click="goHome">
        回到工作台
      </NButton>
    </div>
  </div>
</template>

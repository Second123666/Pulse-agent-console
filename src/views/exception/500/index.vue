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
      <SignalScene variant="overload" code="500" caption="服务出了点问题" />
      <p class="text-sm text-slate-500 dark:text-neutral-400">
        先刷新试试；如果一直这样，确认后端服务是否已启动（端口 3002）。
      </p>
      <NButton type="primary" @click="goHome">
        回到工作台
      </NButton>
    </div>
  </div>
</template>

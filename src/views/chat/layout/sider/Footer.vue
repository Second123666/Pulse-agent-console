<script setup lang='ts'>
import { defineAsyncComponent, ref } from 'vue'
import { useRouter } from 'vue-router'
import { HoverButton, SvgIcon, UserAvatar } from '@/components/common'
import { useAuthStore } from '@/store'

const Setting = defineAsyncComponent(() => import('@/components/common/Setting/index.vue'))

const router = useRouter()
const authStore = useAuthStore()

const show = ref(false)

function handleLogout() {
  authStore.logout()
  router.replace({ name: 'Login' })
}
</script>

<template>
  <footer class="flex items-center justify-between min-w-0 p-4 overflow-hidden border-t dark:border-neutral-800">
    <div class="flex-1 flex-shrink-0 overflow-hidden">
      <UserAvatar />
    </div>

    <HoverButton :tooltip="$t('auth.logout')" @click="handleLogout">
      <span class="text-xl text-[#4f555e] dark:text-white">
        <SvgIcon icon="ri:logout-box-r-line" />
      </span>
      <!-- 图标按钮没有可读文本：补一个视觉隐藏的标签，供屏幕阅读器与自动化测试识别 -->
      <span class="sr-only">{{ $t('auth.logout') }}</span>
    </HoverButton>

    <HoverButton @click="show = true">
      <span class="text-xl text-[#4f555e] dark:text-white">
        <SvgIcon icon="ri:settings-4-line" />
      </span>
    </HoverButton>

    <Setting v-if="show" v-model:visible="show" />
  </footer>
</template>

<script setup lang='ts'>
import { computed } from 'vue'
import { NAvatar } from 'naive-ui'
import { useAuthStore, useUserStore } from '@/store'
import defaultAvatar from '@/assets/avatar.jpg'
import { isString } from '@/utils/is'

const userStore = useUserStore()
const authStore = useAuthStore()

const userInfo = computed(() => userStore.userInfo)

/**
 * 显示名 = 本地昵称（设置面板里改过才有）→ 回落到当前账号的用户名。
 *
 * 本地的 userInfo 只是一份「显示偏好」，不是身份；身份在 authStore.user（登录 /
 * 刷新时由路由守卫保证就位）。早先只读本地那份、且默认值写死成上游作者的名字，
 * 于是**每个账号都显示同一个名字**，用户不改设置就永远看不到自己是谁。
 * 这里用回落而不是把用户名写进 userInfo：两份状态同步迟早会不一致
 * （换账号、清缓存、守卫还没拉到 user 时各是一套）。
 */
const displayName = computed(() =>
  userInfo.value.name || authStore.user?.username || '—',
)
</script>

<template>
  <div class="flex items-center overflow-hidden">
    <div class="w-10 h-10 overflow-hidden rounded-full shrink-0">
      <template v-if="isString(userInfo.avatar) && userInfo.avatar.length > 0">
        <NAvatar
          size="large"
          round
          :src="userInfo.avatar"
          :fallback-src="defaultAvatar"
        />
      </template>
      <template v-else>
        <NAvatar size="large" round :src="defaultAvatar" />
      </template>
    </div>
    <div class="flex-1 min-w-0 ml-2">
      <h2 class="overflow-hidden font-bold text-md text-ellipsis whitespace-nowrap">
        {{ displayName }}
      </h2>
      <p class="overflow-hidden text-xs text-gray-500 text-ellipsis whitespace-nowrap">
        <span
          v-if="isString(userInfo.description) && userInfo.description !== ''"
          v-html="userInfo.description"
        />
      </p>
    </div>
  </div>
</template>

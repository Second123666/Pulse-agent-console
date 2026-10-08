<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton, NInput, useMessage } from 'naive-ui'
import { useRoute, useRouter } from 'vue-router'
import { BrandLogo, SvgIcon } from '@/components/common'
import { t } from '@/locales'
import { useAuthStore } from '@/store'

type Mode = 'login' | 'register'

const MODES: Array<{ value: Mode; label: string }> = [
  { value: 'login', label: 'auth.login' },
  { value: 'register', label: 'auth.register' },
]

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const ms = useMessage()

const mode = ref<Mode>('login')
const username = ref('')
const password = ref('')
const inviteCode = ref('')
const loading = ref(false)

const isRegister = computed(() => mode.value === 'register')

/** 邀请码仅在后端配置了 AUTH_SECRET_KEY（/session 的 auth 字段为 true）且处于注册模式时才需要 */
const needInviteCode = computed(() => isRegister.value && authStore.needInviteCode)

const disabled = computed(() => {
  if (loading.value || !username.value.trim() || !password.value)
    return true
  return needInviteCode.value && !inviteCode.value.trim()
})

/** 登录后的回跳目标：只接受站内路径，防开放重定向 */
const redirect = computed(() => {
  const value = route.query.redirect
  const path = typeof value === 'string' ? value : ''
  return (path.startsWith('/') && !path.startsWith('//')) ? path : '/'
})

function switchMode(next: Mode) {
  if (mode.value === next)
    return

  mode.value = next
  password.value = ''
  inviteCode.value = ''
}

async function handleSubmit() {
  if (disabled.value)
    return

  loading.value = true
  try {
    const name = username.value.trim()

    if (isRegister.value)
      await authStore.register(name, password.value, inviteCode.value.trim() || undefined)
    else
      await authStore.login(name, password.value)

    ms.success(isRegister.value ? t('auth.registerSuccess') : t('auth.loginSuccess'))
    await router.replace(redirect.value)
  }
  catch (error: any) {
    // 后端失败原因（用户名或密码错误 / 邀请码无效 / 用户名已存在）由 http 层透出
    ms.error(error?.message || (isRegister.value ? t('auth.registerFailed') : t('auth.loginFailed')))
  }
  finally {
    loading.value = false
  }
}

function handlePress(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    handleSubmit()
  }
}

onMounted(() => {
  // 注册是否需要邀请码由后端的 AUTH_SECRET_KEY 决定，取一次 /session 得知
  // （路由守卫通常已拉过，这里兜底：直接访问 /login 时也能拿到）
  if (!authStore.session)
    authStore.getSession().catch(() => {})
})
</script>

<template>
  <div class="flex items-center justify-center min-h-full px-4 py-10 bg-[var(--agent-bg)]">
    <div class="w-full max-w-[400px]">
      <header class="mb-6 text-center">
        <div class="flex items-center justify-center gap-2.5">
          <BrandLogo :size="34" />
          <h1 class="text-xl font-semibold text-[var(--agent-text)]">
            思脉AI工作台
          </h1>
        </div>
        <p class="mt-2 font-mono text-xs text-[var(--agent-text-dim)]">
          pulse · agent console
        </p>
      </header>

      <div class="p-6 border rounded-xl shadow-sm bg-[var(--agent-surface)] border-[var(--agent-hairline)]">
        <!-- 登录 / 注册 模式切换 -->
        <div class="flex p-1 mb-5 border rounded-lg bg-[var(--agent-bg)] border-[var(--agent-hairline)]">
          <button
            v-for="item in MODES"
            :key="item.value"
            type="button"
            class="flex-1 py-1.5 text-sm rounded-md transition-colors"
            :class="mode === item.value
              ? 'bg-[var(--agent-surface)] text-[var(--agent-text)] font-medium shadow-sm'
              : 'text-[var(--agent-text-dim)] hover:text-[var(--agent-text)]'"
            @click="switchMode(item.value)"
          >
            {{ $t(item.label) }}
          </button>
        </div>

        <div class="space-y-4">
          <label class="block">
            <span class="block mb-1.5 text-xs text-[var(--agent-text-dim)]">{{ $t('auth.username') }}</span>
            <NInput
              v-model:value="username"
              :placeholder="$t('auth.usernamePlaceholder')"
              :maxlength="32"
              @keypress="handlePress"
            >
              <template #prefix>
                <SvgIcon icon="ri:user-line" class="text-[var(--agent-text-dim)]" />
              </template>
            </NInput>
          </label>

          <label class="block">
            <span class="block mb-1.5 text-xs text-[var(--agent-text-dim)]">{{ $t('auth.password') }}</span>
            <NInput
              v-model:value="password"
              type="password"
              show-password-on="click"
              :placeholder="$t('auth.passwordPlaceholder')"
              :maxlength="128"
              @keypress="handlePress"
            >
              <template #prefix>
                <SvgIcon icon="ri:lock-password-line" class="text-[var(--agent-text-dim)]" />
              </template>
            </NInput>
          </label>

          <label v-if="needInviteCode" class="block">
            <span class="block mb-1.5 text-xs text-[var(--agent-text-dim)]">{{ $t('auth.inviteCode') }}</span>
            <NInput
              v-model:value="inviteCode"
              :placeholder="$t('auth.inviteCodePlaceholder')"
              @keypress="handlePress"
            >
              <template #prefix>
                <SvgIcon icon="ri:ticket-line" class="text-[var(--agent-text-dim)]" />
              </template>
            </NInput>
          </label>

          <NButton
            type="primary"
            block
            :loading="loading"
            :disabled="disabled"
            @click="handleSubmit"
          >
            {{ isRegister ? $t('auth.registerButton') : $t('auth.loginButton') }}
          </NButton>
        </div>

        <p v-if="isRegister" class="mt-4 text-xs text-center text-[var(--agent-text-dim)]">
          {{ $t('auth.adminHint') }}
        </p>
      </div>
    </div>
  </div>
</template>

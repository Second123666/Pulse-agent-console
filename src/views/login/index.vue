<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton, NInput, useMessage } from 'naive-ui'
import { useRoute, useRouter } from 'vue-router'
import { BrandLogo, SvgIcon } from '@/components/common'
import { t } from '@/locales'
import { useAuthStore } from '@/store'

type Mode = 'login' | 'register'
type BackendState = 'checking' | 'online' | 'offline'

const MODES: Array<{ value: Mode; label: string }> = [
  { value: 'login', label: 'auth.login' },
  { value: 'register', label: 'auth.register' },
]

/**
 * 脉搏轨迹：登录页的**状态仪表**，不是装饰。
 * 与 BrandLogo 的波形、错误页 SignalScene 的轨迹同源 —— 同一条信号在这里量的是
 * 「工作台是否够得着」：通的时候画到底、末端亮点呼吸；不通就断在半途并标出故障点。
 */
const TRACE_OK = 'M0 48 H56 L70 20 L88 76 L100 34 L110 48 H196 L208 30 L222 62 L232 48 H340 L352 40 L362 48 H414'
const TRACE_FAULT = 'M0 48 H56 L70 20 L88 76 L100 34 L110 48 H196 L208 30 L222 62 L232 48 H268'
const FAULT_X = 268

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const ms = useMessage()

const mode = ref<Mode>('login')
const username = ref('')
const password = ref('')
const inviteCode = ref('')
const loading = ref(false)
const backendState = ref<BackendState>('checking')

const isRegister = computed(() => mode.value === 'register')

/** 邀请码仅在后端配置了 AUTH_SECRET_KEY（/session 的 auth 字段为 true）且处于注册模式时才需要 */
const needInviteCode = computed(() => isRegister.value && authStore.needInviteCode)

/**
 * 提交时才校验，**不把按钮做成禁用态** —— 禁用的 CTA 在首屏是一片灰，
 * 页面最该有的信心反而最弱。缺字段就按下不放，给出「缺什么」的明确提示
 */
const disabled = computed(() => loading.value)

/** 登录后的回跳目标：只接受站内路径，防开放重定向 */
const redirect = computed(() => {
  const value = route.query.redirect
  const path = typeof value === 'string' ? value : ''
  return (path.startsWith('/') && !path.startsWith('//')) ? path : '/'
})

/** 有回跳目标时才提示「登录后回到刚才那页」，否则不提 */
const hasRedirect = computed(() => redirect.value !== '/')

const statusText = computed(() => {
  if (backendState.value === 'checking')
    return t('auth.statusChecking')
  if (backendState.value === 'online')
    return t('auth.statusOnline')
  return t('auth.statusOffline')
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

  // 缺哪一项就点名哪一项 —— 比灰掉的按钮更明确
  const name = username.value.trim()
  if (!name) {
    ms.error(t('auth.usernameRequired'))
    return
  }
  if (!password.value) {
    ms.error(t('auth.passwordRequired'))
    return
  }
  if (needInviteCode.value && !inviteCode.value.trim()) {
    ms.error(t('auth.inviteCodeRequired'))
    return
  }

  loading.value = true
  try {
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

onMounted(async () => {
  // /session 兼作连通性探针：它同时给出「注册是否需要邀请码」（后端 AUTH_SECRET_KEY）
  // 与「服务端是否够得着」。
  // **每次都真发一次**，不复用守卫刚拿到的 session —— 状态行的价值就在于它是活的；
  // 复用缓存的话它永远只有一句「已连接」，那不是读数是装饰
  // （后端在整页加载时就不可达的情况由守卫接管 → /500，见 permission.ts）
  try {
    await authStore.getSession()
    backendState.value = 'online'
  }
  catch {
    backendState.value = 'offline'
  }
})
</script>

<template>
  <div class="auth-page">
    <div class="auth-column">
      <!-- 仪表：一条与产品同源的脉搏线。连通时画到底、末端呼吸；不通就断在半途 -->
      <div class="scope" :class="`scope--${backendState}`">
        <svg
          viewBox="0 0 420 96" class="scope__svg" fill="none" preserveAspectRatio="none"
          aria-hidden="true" xmlns="http://www.w3.org/2000/svg"
        >
          <!-- 故障态的尾巴：信号已经没了，只剩安静的地平线 -->
          <path
            v-if="backendState === 'offline'" d="M268 48 H420" stroke="var(--agent-text-dim)"
            stroke-width="2" stroke-linecap="round" stroke-dasharray="2 8" opacity="0.5"
          />
          <path
            :d="backendState === 'offline' ? TRACE_FAULT : TRACE_OK"
            class="scope__line" pathLength="1" stroke="var(--agent-accent)"
            stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
          />
          <circle
            v-if="backendState === 'offline'" class="scope__fault"
            :cx="FAULT_X" cy="48" r="4" fill="var(--signal-fault)"
          />
          <circle
            v-else-if="backendState === 'online'" class="scope__tip"
            cx="414" cy="48" r="4" fill="var(--agent-accent)"
          />
        </svg>
      </div>

      <section class="auth-panel">
        <!-- 铭牌：左对齐，与下面的表单共用同一条左轴 -->
        <header class="flex items-center gap-3">
          <BrandLogo :size="36" />
          <div class="min-w-0">
            <h1 class="text-lg font-semibold leading-tight tracking-wider text-[var(--agent-text)]">
              思脉AI工作台
            </h1>
            <p class="font-mono text-[11px] leading-tight text-[var(--agent-text-dim)]">
              pulse · agent console
            </p>
          </div>
        </header>

        <!-- 通道选择：登录 / 注册 -->
        <div class="mode-switch">
          <span class="mode-switch__thumb" :class="{ 'mode-switch__thumb--right': isRegister }" aria-hidden="true" />
          <button
            v-for="item in MODES" :key="item.value" type="button"
            :aria-pressed="mode === item.value"
            class="mode-switch__item" :class="{ 'mode-switch__item--active': mode === item.value }"
            @click="switchMode(item.value)"
          >
            {{ $t(item.label) }}
          </button>
        </div>

        <!-- 真表单：Enter 走浏览器原生提交，不再自己拦 keypress -->
        <form class="mt-5 space-y-4" @submit.prevent="handleSubmit">
          <label class="block">
            <span class="field-label">{{ $t('auth.username') }}</span>
            <NInput
              v-model:value="username" size="large" :placeholder="$t('auth.usernamePlaceholder')"
              :maxlength="32"
            >
              <template #prefix>
                <SvgIcon icon="ri:user-line" class="text-[var(--agent-text-dim)]" />
              </template>
            </NInput>
          </label>

          <label class="block">
            <span class="field-label">{{ $t('auth.password') }}</span>
            <NInput
              v-model:value="password" size="large" type="password" show-password-on="click"
              :placeholder="$t('auth.passwordPlaceholder')" :maxlength="128"
            >
              <template #prefix>
                <SvgIcon icon="ri:lock-password-line" class="text-[var(--agent-text-dim)]" />
              </template>
            </NInput>
          </label>

          <label v-if="needInviteCode" class="block">
            <span class="field-label">{{ $t('auth.inviteCode') }}</span>
            <NInput
              v-model:value="inviteCode" size="large" :placeholder="$t('auth.inviteCodePlaceholder')"
            >
              <template #prefix>
                <SvgIcon icon="ri:ticket-line" class="text-[var(--agent-text-dim)]" />
              </template>
            </NInput>
          </label>

          <NButton
            attr-type="submit" type="primary" size="large" block
            :loading="loading" :disabled="disabled"
          >
            {{ isRegister ? $t('auth.createAccount') : $t('auth.enterWorkbench') }}
          </NButton>
        </form>

        <p v-if="isRegister" class="mt-4 flex items-start gap-1.5 text-xs leading-relaxed text-[var(--agent-text-dim)]">
          <SvgIcon icon="ri:shield-keyhole-line" class="mt-0.5 shrink-0 text-[13px]" />
          <span>{{ $t('auth.adminHint') }}</span>
        </p>

        <!-- 面板底部读数：与上面的表单共用同一条左轴（放在面板外会掉到容器边，轴就断了） -->
        <div class="auth-panel__readout">
          <p class="status-line" :class="`status-line--${backendState}`">
            <span class="status-dot" aria-hidden="true" />
            <span>{{ statusText }}</span>
          </p>
          <p v-if="hasRedirect" class="redirect-hint">
            {{ $t('auth.redirectHint') }}
          </p>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped lang="less">
.auth-page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100%;
  padding: 40px 16px;
  background: var(--agent-bg);
}

.auth-column {
  width: 100%;
  max-width: 420px;
  // 整台机器一起进场（屏与机身同动，否则进场时两者会裂开）
  animation: panel-in 420ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
}

// ---- 仪表（与下面的面板是同一台机器：屏坐在机身上）----
.scope {
  // 故障色与错误页 SignalScene 同一个值、同一个语义（信号异常），同样刻意不进全局令牌
  --signal-fault: #d97706;

  position: relative;
  overflow: hidden; // 圆角会裁掉方格与轨迹的溢出
  background: var(--agent-surface);
  border: 1px solid var(--agent-hairline);
  border-bottom: none;
  border-radius: 14px 14px 0 0;

  // 示波器方格：只在中间实、上下淡出，往下淡进白色面板，衔接处没有硬线
  &::before {
    content: '';
    position: absolute;
    inset: 0;
    background-image:
      repeating-linear-gradient(to right, var(--agent-hairline) 0 1px, transparent 1px 28px),
      repeating-linear-gradient(to bottom, var(--agent-hairline) 0 1px, transparent 1px 28px);
    mask-image: linear-gradient(to bottom, transparent, #000 22%, #000 70%, transparent);
    opacity: 0.45;
  }

  // 高度交给 viewBox 比例（420×96）自己算：等比缩放，圆点不会被拉成椭圆
  &__svg {
    position: relative;
    display: block;
    width: 100%;
    height: auto;
  }

  // 进场：轨迹逐段画出（与错误页 SignalScene 同一手法，900ms 同一条缓动）
  &__line {
    stroke-dasharray: 1;
    stroke-dashoffset: 1;
    animation: pulse-draw 900ms cubic-bezier(0.22, 0.61, 0.36, 1) forwards;
  }

  // 连通：末端亮点缓慢呼吸 —— 这是页面上唯一的持续动效，它表示「信号还在」
  &__tip {
    transform-box: fill-box;
    transform-origin: center;
    opacity: 0;
    animation:
      pulse-mark 320ms ease-out 780ms forwards,
      tip-breathe 2.8s ease-in-out 1.1s infinite;
  }

  &__fault {
    opacity: 0;
    animation: pulse-mark 320ms ease-out 780ms forwards;
  }
}

// ---- 面板 ----
.auth-panel {
  padding: 24px;
  // 上边与仪表屏相接：两者都不画这条线，屏底的方格直接淡进白色，接缝是看不见的
  border: 1px solid var(--agent-hairline);
  border-top: none;
  border-radius: 0 0 14px 14px;
  background: var(--agent-surface);

  // 底部读数：一条发丝线把它和表单分开，左轴与表单对齐
  &__readout {
    margin-top: 20px;
    padding-top: 14px;
    border-top: 1px solid var(--agent-hairline);
  }
}

.mode-switch {
  position: relative;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  margin-top: 20px;
  padding: 4px;
  border: 1px solid var(--agent-hairline);
  border-radius: 10px;
  background: var(--agent-bg);

  &__thumb {
    position: absolute;
    top: 4px;
    bottom: 4px;
    left: 4px;
    width: calc(50% - 6px);
    border-radius: 7px;
    background: var(--agent-surface);
    box-shadow: 0 1px 2px rgb(0 0 0 / 6%);
    transition: transform 180ms cubic-bezier(0.22, 1, 0.36, 1);

    &--right {
      transform: translateX(calc(100% + 4px));
    }
  }

  &__item {
    position: relative;
    padding: 6px 0;
    font-size: 13px;
    color: var(--agent-text-dim);
    transition: color 140ms ease;

    &:hover {
      color: var(--agent-text);
    }

    &--active {
      color: var(--agent-text);
      font-weight: 500;
    }

    &:focus-visible {
      outline: 2px solid var(--agent-accent);
      outline-offset: 2px;
      border-radius: 7px;
    }
  }
}

.field-label {
  display: block;
  margin-bottom: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  letter-spacing: 0.04em;
  color: var(--agent-text-dim);
}

// ---- 状态行 ----
.status-line {
  display: flex;
  align-items: center;
  gap: 7px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  color: var(--agent-text-dim);
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--agent-text-dim);
  flex-shrink: 0;
}

.status-line--checking .status-dot {
  animation: tip-breathe 1.6s ease-in-out infinite;
}

.status-line--online .status-dot {
  background: var(--agent-accent);
}

.status-line--offline .status-dot {
  background: var(--signal-fault);
}

.redirect-hint {
  font-size: 11px;
  color: var(--agent-text-dim);
  opacity: 0.85;
}

html.dark .scope {
  --signal-fault: #fbbf24;
}

@keyframes pulse-draw {
  to {
    stroke-dashoffset: 0;
  }
}

@keyframes pulse-mark {
  to {
    opacity: 1;
  }
}

@keyframes tip-breathe {
  0%,
  100% {
    opacity: 0.35;
    transform: scale(0.82);
  }

  50% {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes panel-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .scope__line {
    animation: none;
    stroke-dashoffset: 0;
  }

  .scope__tip,
  .scope__fault {
    animation: none;
    opacity: 1;
  }

  .status-line--checking .status-dot {
    animation: none;
  }

  .auth-column {
    animation: none;
  }

  .mode-switch__thumb {
    transition: none;
  }
}

@media (max-width: 480px) {
  .auth-page {
    padding: 24px 14px;
  }

  .auth-panel {
    padding: 20px;
  }
}
</style>

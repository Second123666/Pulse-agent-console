<script setup lang='ts'>
import { onMounted, ref } from 'vue'
import { NAlert, NSpin } from 'naive-ui'
import type { UsageSummary } from '@/api'
import { fetchUsageSummary } from '@/api'
import { t } from '@/locales'

const loading = ref(false)
const error = ref('')
const summary = ref<UsageSummary>()

/** token 数简写：1234 → 1.2k（与消息气泡下那行小字同一套写法） */
function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0)
    return '0'
  return value < 1000 ? String(Math.round(value)) : `${(value / 1000).toFixed(1)}k`
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0)
    return '0s'
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const { data } = await fetchUsageSummary()
    summary.value = data
  }
  catch (err: any) {
    // 面板是只读统计，失败时给一行提示即可，不弹全局错误
    error.value = err?.message ?? t('setting.usageLoadFailed')
  }
  finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <NSpin :show="loading">
    <div class="p-4 space-y-4">
      <NAlert v-if="error" type="warning" :bordered="false">
        {{ error }}
      </NAlert>

      <template v-if="summary">
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div class="p-3 rounded-md bg-neutral-100 dark:bg-neutral-700">
            <div class="text-xs text-neutral-500 dark:text-neutral-400">
              {{ $t('setting.usageRuns') }}
            </div>
            <div class="mt-1 text-lg font-semibold">
              {{ summary.total.runs }}
            </div>
          </div>
          <div class="p-3 rounded-md bg-neutral-100 dark:bg-neutral-700">
            <div class="text-xs text-neutral-500 dark:text-neutral-400">
              {{ $t('setting.usageInput') }}
            </div>
            <div class="mt-1 text-lg font-semibold font-mono">
              {{ formatTokens(summary.total.promptTokens) }}
            </div>
          </div>
          <div class="p-3 rounded-md bg-neutral-100 dark:bg-neutral-700">
            <div class="text-xs text-neutral-500 dark:text-neutral-400">
              {{ $t('setting.usageOutput') }}
            </div>
            <div class="mt-1 text-lg font-semibold font-mono">
              {{ formatTokens(summary.total.completionTokens) }}
            </div>
          </div>
          <div class="p-3 rounded-md bg-neutral-100 dark:bg-neutral-700">
            <div class="text-xs text-neutral-500 dark:text-neutral-400">
              {{ $t('setting.usageDuration') }}
            </div>
            <div class="mt-1 text-lg font-semibold font-mono">
              {{ formatDuration(summary.total.durationMs) }}
            </div>
          </div>
        </div>

        <div>
          <h3 class="mb-2 text-sm font-semibold">
            {{ $t('setting.usageByDay') }}
          </h3>
          <p v-if="!summary.daily.length" class="text-sm text-neutral-500 dark:text-neutral-400">
            {{ $t('common.noData') }}
          </p>
          <table v-else class="w-full text-sm">
            <thead class="text-xs text-neutral-500 dark:text-neutral-400">
              <tr class="text-left">
                <th class="py-1 font-normal">
                  {{ $t('setting.usageDate') }}
                </th>
                <th class="py-1 font-normal text-right">
                  {{ $t('setting.usageRuns') }}
                </th>
                <th class="py-1 font-normal text-right">
                  in
                </th>
                <th class="py-1 font-normal text-right">
                  out
                </th>
                <th class="py-1 font-normal text-right">
                  {{ $t('setting.usageDuration') }}
                </th>
              </tr>
            </thead>
            <tbody class="font-mono">
              <tr v-for="row in summary.daily" :key="row.date" class="border-t border-neutral-200 dark:border-neutral-700">
                <td class="py-1">
                  {{ row.date }}
                </td>
                <td class="py-1 text-right">
                  {{ row.runs }}
                </td>
                <td class="py-1 text-right">
                  {{ formatTokens(row.promptTokens) }}
                </td>
                <td class="py-1 text-right">
                  {{ formatTokens(row.completionTokens) }}
                </td>
                <td class="py-1 text-right">
                  {{ formatDuration(row.durationMs) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div>
          <h3 class="mb-2 text-sm font-semibold">
            {{ $t('setting.usageByConversation') }}
          </h3>
          <p v-if="!summary.conversations.length" class="text-sm text-neutral-500 dark:text-neutral-400">
            {{ $t('common.noData') }}
          </p>
          <table v-else class="w-full text-sm">
            <thead class="text-xs text-neutral-500 dark:text-neutral-400">
              <tr class="text-left">
                <th class="py-1 font-normal">
                  {{ $t('setting.usageConversation') }}
                </th>
                <th class="py-1 font-normal text-right">
                  {{ $t('setting.usageRuns') }}
                </th>
                <th class="py-1 font-normal text-right">
                  in
                </th>
                <th class="py-1 font-normal text-right">
                  out
                </th>
              </tr>
            </thead>
            <tbody class="font-mono">
              <tr
                v-for="row in summary.conversations" :key="row.conversationUuid ?? 'none'"
                class="border-t border-neutral-200 dark:border-neutral-700"
              >
                <td class="py-1">
                  {{ row.conversationUuid ?? $t('setting.usageNoConversation') }}
                </td>
                <td class="py-1 text-right">
                  {{ row.runs }}
                </td>
                <td class="py-1 text-right">
                  {{ formatTokens(row.promptTokens) }}
                </td>
                <td class="py-1 text-right">
                  {{ formatTokens(row.completionTokens) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <p class="text-xs text-neutral-500 dark:text-neutral-400">
          {{ $t('setting.usageWindow', { days: summary.days }) }}
        </p>
      </template>
    </div>
  </NSpin>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { NAlert, NButton, NPopconfirm, NSpin, NTag, useMessage } from 'naive-ui'
import type { KnowledgeDoc } from '@/api'
import { deleteKnowledge, fetchKnowledgeList, uploadKnowledge } from '@/api'
import { SvgIcon } from '@/components/common'
import { t } from '@/locales'

/**
 * 与后端 `service/src/knowledge/store.ts` 的 MAX_UPLOAD_BYTES / ALLOWED_EXTENSIONS
 * 保持一致 —— 前端拦一次是为了不白跑一趟上传，后端仍会再校验一次（不能只信前端）。
 */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024
const ALLOWED_EXTENSIONS = ['.md', '.txt']

const ms = useMessage()

const loading = ref(false)
const uploading = ref(false)
const dragOver = ref(false)
const error = ref('')
const docs = ref<KnowledgeDoc[]>([])

const fileInput = ref<HTMLInputElement>()

async function load() {
  loading.value = true
  error.value = ''
  try {
    const { data } = await fetchKnowledgeList()
    docs.value = data.docs ?? []
  }
  catch (err: any) {
    // 列表读不到时给一行提示即可，不弹全局错误
    error.value = err?.message ?? t('setting.knowledgeLoadFailed')
  }
  finally {
    loading.value = false
  }
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.')
  return index > 0 ? name.slice(index).toLowerCase() : ''
}

function formatBytes(bytes: number): string {
  if (bytes < 1024)
    return `${bytes}B`
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`
}

/** 选文件阶段就拦下不合格的文件，返回具体原因；合格返回 null */
function validate(file: File): string | null {
  const ext = extensionOf(file.name)
  if (!ALLOWED_EXTENSIONS.includes(ext))
    return t('setting.knowledgeBadType', { ext: ext || '-' })
  if (file.size === 0)
    return t('setting.knowledgeEmptyFile')
  if (file.size > MAX_UPLOAD_BYTES)
    return t('setting.knowledgeTooLarge', { size: formatBytes(file.size) })
  return null
}

/** FileReader 读成 dataURL 再截掉前缀，得到纯 base64（与后端 decodeBase64 的入参对应） */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

async function uploadFile(file: File) {
  const reason = validate(file)
  if (reason) {
    error.value = reason
    ms.error(reason)
    return
  }

  uploading.value = true
  error.value = ''
  try {
    const contentBase64 = await readBase64(file)
    await uploadKnowledge(file.name, contentBase64)
    ms.success(t('setting.knowledgeUploadSuccess'))
    await load()
  }
  catch (err: any) {
    // 后端会给出具体原因（类型不支持 / 过大 / 向量化失败），原样透出 —— 不能笼统「上传失败」
    const message = err?.message || t('setting.knowledgeUploadFailed')
    error.value = message
    ms.error(message)
  }
  finally {
    uploading.value = false
  }
}

function triggerPick() {
  fileInput.value?.click()
}

function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  // 清空 value：否则连着两次选同一个文件不会触发 change
  input.value = ''
  if (file)
    uploadFile(file)
}

function onDrop(event: DragEvent) {
  dragOver.value = false
  const file = event.dataTransfer?.files?.[0]
  if (file)
    uploadFile(file)
}

async function remove(doc: KnowledgeDoc) {
  try {
    await deleteKnowledge(doc.docId)
    ms.success(t('common.deleteSuccess'))
    await load()
  }
  catch (err: any) {
    const message = err?.message || t('common.failed')
    error.value = message
    ms.error(message)
  }
}

onMounted(load)
</script>

<template>
  <div class="p-4 space-y-4">
    <NAlert v-if="error" type="warning" :bordered="false">
      {{ error }}
    </NAlert>

    <div
      class="rounded-md border border-dashed p-6 text-center cursor-pointer transition-colors"
      :class="dragOver
        ? 'border-primary bg-neutral-100 dark:bg-neutral-700'
        : 'border-neutral-300 dark:border-neutral-600'"
      @click="triggerPick"
      @dragover.prevent="dragOver = true"
      @dragleave="dragOver = false"
      @drop.prevent="onDrop"
    >
      <template v-if="uploading">
        <SvgIcon class="text-3xl animate-pulse" icon="ri:upload-cloud-2-line" />
        <p class="mt-2 text-sm">
          {{ $t('setting.knowledgeUploading') }}
        </p>
      </template>
      <template v-else>
        <SvgIcon class="text-3xl" icon="ri:upload-cloud-2-line" />
        <p class="mt-2 text-sm">
          {{ $t('setting.knowledgeDropzone') }}
        </p>
        <p class="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          {{ $t('setting.knowledgeMaxSize') }}
        </p>
      </template>
      <input ref="fileInput" type="file" class="hidden" accept=".md,.txt" @change="onFileChange">
    </div>

    <NSpin :show="loading">
      <div class="space-y-2">
        <p v-if="!docs.length" class="text-sm text-neutral-500 dark:text-neutral-400">
          {{ $t('setting.knowledgeEmpty') }}
        </p>
        <table v-else class="w-full text-sm">
          <thead class="text-xs text-neutral-500 dark:text-neutral-400">
            <tr class="text-left">
              <th class="py-1 font-normal">
                {{ $t('setting.knowledgeName') }}
              </th>
              <th class="py-1 font-normal text-right">
                {{ $t('setting.knowledgeChunks') }}
              </th>
              <th class="py-1 font-normal text-right">
                {{ $t('setting.knowledgeChars') }}
              </th>
              <th class="py-1 font-normal">
                {{ $t('setting.knowledgeCreatedAt') }}
              </th>
              <th class="py-1 font-normal text-right">
                {{ $t('common.action') }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="doc in docs" :key="doc.docId"
              class="border-t border-neutral-200 dark:border-neutral-700"
            >
              <td class="py-1">
                <span class="break-all">{{ doc.name }}</span>
                <NTag v-if="!doc.indexed" class="ml-1 align-middle" size="tiny" type="warning">
                  {{ $t('setting.knowledgeUnindexed') }}
                </NTag>
              </td>
              <td class="py-1 text-right font-mono">
                {{ doc.chunks }}
              </td>
              <td class="py-1 text-right font-mono">
                {{ doc.chars.toLocaleString() }}
              </td>
              <td class="py-1">
                {{ new Date(doc.createdAt).toLocaleString() }}
              </td>
              <td class="py-1 text-right">
                <NPopconfirm placement="left" :disabled="uploading" @positive-click="remove(doc)">
                  <template #trigger>
                    <NButton size="tiny" :disabled="uploading">
                      {{ $t('common.delete') }}
                    </NButton>
                  </template>
                  {{ $t('setting.knowledgeDeleteConfirm') }}
                </NPopconfirm>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </NSpin>
  </div>
</template>

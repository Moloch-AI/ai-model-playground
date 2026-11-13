<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { copyText } from '../lib/clipboard'

const props = defineProps<{ text: string; label: string; disabled?: boolean }>()

const feedback = ref('')
let timer: ReturnType<typeof setTimeout> | undefined

async function copy() {
  const ok = await copyText(props.text)
  feedback.value = ok ? 'Copied' : 'Copy failed: select the text and copy it manually'
  clearTimeout(timer)
  timer = setTimeout(() => {
    feedback.value = ''
  }, 2500)
}

onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <span class="copy">
    <button type="button" class="btn btn-small" :disabled="disabled || !text" @click="copy">
      {{ feedback === 'Copied' ? 'Copied' : label }}
    </button>
    <span class="visually-hidden" role="status">{{ feedback }}</span>
  </span>
</template>

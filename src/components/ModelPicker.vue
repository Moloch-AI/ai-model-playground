<script setup lang="ts">
import { computed } from 'vue'
import type { ErrorInfo } from '../lib/errors'
import { LINKS } from '../lib/links'
import type { ModelInfo } from '../lib/types'
import ErrorPanel from './ErrorPanel.vue'

const props = defineProps<{
  models: ModelInfo[]
  loading: boolean
  error: ErrorInfo | null
  contextLimit: number | null
}>()
const model = defineModel<string>({ required: true })
const emit = defineEmits<{ refresh: [] }>()

const selected = computed(() => props.models.find((m) => m.id === model.value) ?? null)
const unavailableCount = computed(() => props.models.filter((m) => m.available === false).length)

function optionLabel(m: ModelInfo): string {
  const name = m.name || m.id
  return m.available === false ? `${name} (unavailable)` : name
}
</script>

<template>
  <section class="card" aria-labelledby="model-title">
    <div class="card-head">
      <h2 id="model-title">Model</h2>
      <button type="button" class="btn btn-small" :disabled="loading" @click="emit('refresh')">
        {{ loading ? 'Loading…' : 'Refresh' }}
      </button>
    </div>
    <div class="stack">
      <div>
        <label for="model-select" class="visually-hidden">Model</label>
        <select id="model-select" v-model="model" :disabled="loading || models.length === 0">
          <option v-if="models.length === 0" value="">{{ loading ? 'Loading models…' : 'No models' }}</option>
          <option v-for="m in models" :key="m.id" :value="m.id">{{ optionLabel(m) }}</option>
        </select>
      </div>
      <p v-if="selected" class="hint">
        id <code>{{ selected.id }}</code>
        <template v-if="contextLimit"> · context {{ contextLimit.toLocaleString('en-US') }} tokens</template>
      </p>
      <div v-if="selected && selected.available === false" class="notice notice-warning" role="note">
        <strong>No server is serving this model right now.</strong>
        <p>
          Requests to it return <code>503 model_unavailable</code>. The API does not switch to another
          model for you, so try again in a few minutes or pick an available one.
        </p>
      </div>
      <p v-else-if="unavailableCount > 0" class="hint">
        Models marked unavailable have no server serving them at the moment.
      </p>
      <ErrorPanel v-if="error" :error="error" />
      <p class="hint">
        The list comes from <code>GET /models</code>. Model facts are on each model's card:
        <a :href="LINKS.models" target="_blank" rel="noopener noreferrer">molochai.dev/models</a>.
      </p>
    </div>
  </section>
</template>

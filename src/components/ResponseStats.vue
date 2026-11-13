<script setup lang="ts">
import { computed } from 'vue'
import type { RunState } from '../composables/useRun'

const props = defineProps<{ run: RunState }>()

function ms(value: number | null): string {
  if (value === null) return '—'
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`
}

function tokens(value: number | undefined): string {
  return value === undefined ? '—' : value.toLocaleString('en-US')
}

const rows = computed(() => {
  const run = props.run
  const c = run.completion
  const queue = c.queueNotices > 0 ? `${c.queueNotices}${c.queue ? ` (last: ${c.queue.text})` : ''}` : 'none'
  const rate =
    run.rateLimitRemaining === null
      ? '—'
      : run.rateLimitLimit
        ? `${run.rateLimitRemaining} of ${run.rateLimitLimit} per minute`
        : run.rateLimitRemaining
  return [
    { label: 'Model', value: c.model ?? '—', mono: true },
    { label: 'Finish reason', value: c.finishReason ?? '—', mono: true },
    { label: 'Prompt tokens', value: tokens(c.usage?.prompt_tokens) },
    { label: 'Completion tokens', value: tokens(c.usage?.completion_tokens) },
    { label: 'Total tokens', value: tokens(c.usage?.total_tokens) },
    {
      label: 'Time to first token',
      value: run.streamed ? ms(run.firstTokenMs) : 'n/a (not streamed)',
    },
    { label: 'Total time', value: ms(run.totalMs) },
    { label: 'Queue notices', value: run.streamed ? queue : 'n/a (not streamed)' },
    { label: 'Rate limit remaining', value: rate },
  ]
})
</script>

<template>
  <section class="card" aria-labelledby="stats-title">
    <div class="card-head">
      <h2 id="stats-title">Response info</h2>
    </div>
    <dl class="stats">
      <div v-for="row in rows" :key="row.label" class="stat">
        <dt>{{ row.label }}</dt>
        <dd :class="{ mono: row.mono }">{{ row.value }}</dd>
      </div>
    </dl>
    <p class="hint note">
      Total tokens include reasoning and are what counts against your quota. Rate limit values come from
      the API's <code>X-RateLimit-*</code> headers.
    </p>
  </section>
</template>

<style scoped>
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 10px 16px;
  margin: 0;
}

.stat {
  min-width: 0;
}

.stat dt {
  color: var(--fg-2);
  font-size: 0.8rem;
}

.stat dd {
  margin: 0;
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
}

.note {
  margin-top: 12px;
}
</style>

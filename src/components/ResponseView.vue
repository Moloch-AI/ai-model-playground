<script setup lang="ts">
import { computed } from 'vue'
import type { RunState } from '../composables/useRun'
import { CAP_NOTICE_TEXT, splitCapNotice } from '../lib/cap'
import CopyButton from './CopyButton.vue'
import ErrorPanel from './ErrorPanel.vue'

const props = defineProps<{ run: RunState }>()
const emit = defineEmits<{ append: [] }>()

const busy = computed(() => props.run.status === 'waiting' || props.run.status === 'streaming')
const completion = computed(() => props.run.completion)
const split = computed(() => splitCapNotice(completion.value.content, { partial: busy.value }))
const answer = computed(() => split.value.content)
const toolCalls = computed(() => completion.value.toolCalls.filter(Boolean))
const hasOutput = computed(
  () => answer.value !== '' || completion.value.reasoning !== '' || toolCalls.value.length > 0,
)
const canAppend = computed(() => !busy.value && (answer.value.trim() !== '' || toolCalls.value.length > 0))
const showQueue = computed(() => busy.value && completion.value.queue !== null && !hasOutput.value)

const statusText = computed(() => {
  const run = props.run
  switch (run.status) {
    case 'idle':
      return 'Send a message to see the reply here.'
    case 'waiting':
      return 'Waiting for the server…'
    case 'streaming':
      if (showQueue.value) return 'Queued, waiting for a free slot…'
      return hasOutput.value ? 'Receiving the reply…' : 'Connected, waiting for the first token…'
    case 'done':
      return `Done${run.totalMs !== null ? ` in ${(run.totalMs / 1000).toFixed(1)} s` : ''}.`
    case 'stopped':
      return 'Stopped. The request was cancelled; the text so far is kept below.'
    case 'error':
      return `Failed: ${run.error?.title ?? 'unknown error'}.`
    default:
      return ''
  }
})

function prettyArguments(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}
</script>

<template>
  <section class="card response" aria-labelledby="response-title">
    <div class="card-head">
      <h2 id="response-title">Response</h2>
      <div class="actions">
        <CopyButton :text="answer" label="Copy answer" />
        <button v-if="canAppend" type="button" class="btn btn-small" @click="emit('append')">
          Add to conversation
        </button>
      </div>
    </div>

    <div class="stack">
      <p class="status hint" role="status" aria-live="polite">{{ statusText }}</p>

      <div v-if="showQueue && completion.queue" class="notice notice-info">
        <strong>Queued: position {{ completion.queue.position }} of {{ completion.queue.total }}</strong>
        <p v-if="completion.queue.waitingSeconds !== null">
          Waiting {{ completion.queue.waitingSeconds }} s so far. All slots for this model are busy; the
          reply starts when one frees up.
        </p>
      </div>

      <details v-if="completion.reasoning" class="reasoning">
        <summary>
          Reasoning
          <span class="hint">
            ({{ completion.reasoning.length.toLocaleString('en-US') }} characters<template
              v-if="busy && !answer"
              >, in progress</template
            >)
          </span>
        </summary>
        <p class="text-block reasoning-text">{{ completion.reasoning }}</p>
      </details>
      <p v-if="completion.inlineThink" class="hint">
        This plain (non-streamed) reply carried its reasoning inline in a
        <code>&lt;think&gt;</code> block. It was split out into the Reasoning panel above.
      </p>

      <div v-if="answer || busy" class="answer">
        <h3 class="visually-hidden">Answer</h3>
        <p class="text-block">{{ answer }}<span v-if="run.status === 'streaming'" class="cursor" aria-hidden="true"></span></p>
      </div>

      <div v-if="toolCalls.length" class="tool-calls">
        <h3 class="label">Tool calls</h3>
        <div v-for="call in toolCalls" :key="call.id || call.function.name" class="tool-call">
          <p>
            <code>{{ call.function.name }}</code>
            <span class="hint"> · id <code>{{ call.id }}</code></span>
          </p>
          <pre class="code-block">{{ prettyArguments(call.function.arguments) }}</pre>
        </div>
      </div>

      <div v-if="split.capped" class="notice notice-warning" role="note">
        <strong>{{ CAP_NOTICE_TEXT }}</strong>
        <p>
          The reply reached your plan's output cap per reply, so it is cut off
          (<code>finish_reason: {{ completion.finishReason ?? 'length' }}</code>). The API appends this
          notice to the text; the playground shows it here instead. Ask for a shorter answer or split
          the task.
        </p>
      </div>

      <ErrorPanel v-if="run.error" :error="run.error" />
    </div>
  </section>
</template>

<style scoped>
.reasoning {
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}

.reasoning summary {
  font-weight: 600;
  cursor: pointer;
}

.reasoning-text {
  margin-top: 8px;
  color: var(--fg-2);
  font-size: 0.9rem;
  max-height: 360px;
  overflow-y: auto;
}

.answer {
  min-height: 1.5em;
}

.tool-call + .tool-call {
  margin-top: 8px;
}

.tool-call pre {
  margin-top: 4px;
}
</style>

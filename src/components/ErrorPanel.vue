<script setup lang="ts">
import type { ErrorInfo } from '../lib/errors'

defineProps<{ error: ErrorInfo }>()
</script>

<template>
  <div class="notice notice-danger error-panel" role="alert">
    <strong>{{ error.title }}</strong>
    <p v-if="error.message" class="server-message">
      <span class="hint">{{ error.source === 'playground' ? 'Playground server' : 'API' }} said:</span>
      {{ error.message }}
    </p>
    <ul v-if="error.fields.length" class="fields">
      <li v-for="field in error.fields" :key="field.field">
        <code>{{ field.field }}</code>: {{ field.messages.join(' ') || 'invalid' }}
      </li>
    </ul>
    <dl v-if="error.details.length" class="details">
      <template v-for="detail in error.details" :key="detail.label">
        <dt>{{ detail.label }}</dt>
        <dd>{{ detail.value }}</dd>
      </template>
    </dl>
    <p class="action">{{ error.action }}</p>
    <p v-if="error.links.length" class="links">
      <template v-for="(link, index) in error.links" :key="link.href">
        <span v-if="index > 0" aria-hidden="true"> · </span>
        <a :href="link.href" target="_blank" rel="noopener noreferrer">{{ link.label }}</a>
      </template>
    </p>
    <p class="hint meta">
      <template v-if="error.status !== null">HTTP {{ error.status }}</template>
      <template v-else-if="error.source === 'stream'">Error event inside the stream</template>
      <template v-if="error.type"> · <code>{{ error.type }}</code></template>
      <template v-if="error.retryable"> · safe to retry</template>
      <template v-else> · retrying unchanged will not help</template>
    </p>
  </div>
</template>

<style scoped>
.fields {
  margin: 0;
  padding-left: 20px;
}

.details {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 2px 12px;
  margin: 0;
}

.details dt {
  color: var(--fg-2);
}

.details dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.action {
  font-weight: 600;
}

.meta {
  font-size: 0.8rem;
}
</style>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { toCurl, toPython } from '../lib/codegen'
import type { BuildResult } from '../lib/request'
import CopyButton from './CopyButton.vue'

const props = defineProps<{ build: BuildResult }>()

type Lang = 'curl' | 'python'
const tabs: Array<{ id: Lang; label: string }> = [
  { id: 'curl', label: 'curl' },
  { id: 'python', label: 'Python' },
]
const active = ref<Lang>('curl')

const code = computed(() => {
  if (!props.build.ok) return ''
  return active.value === 'curl' ? toCurl(props.build.request) : toPython(props.build.request)
})

function onTabKey(event: KeyboardEvent) {
  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
  event.preventDefault()
  const index = tabs.findIndex((tab) => tab.id === active.value)
  const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]
  if (!next) return
  active.value = next.id
  document.getElementById(`tab-${next.id}`)?.focus()
}
</script>

<template>
  <section class="card span-all" aria-labelledby="code-title">
    <div class="card-head">
      <h2 id="code-title">Same request as code</h2>
      <div class="actions">
        <CopyButton :text="code" :label="`Copy ${active === 'curl' ? 'curl' : 'Python'}`" />
      </div>
    </div>
    <div class="tabs" role="tablist" aria-label="Language">
      <button
        v-for="tab in tabs"
        :id="`tab-${tab.id}`"
        :key="tab.id"
        type="button"
        role="tab"
        class="tab"
        :aria-selected="active === tab.id"
        :aria-controls="`panel-${tab.id}`"
        :tabindex="active === tab.id ? 0 : -1"
        @click="active = tab.id"
        @keydown="onTabKey"
      >
        {{ tab.label }}
      </button>
    </div>
    <div
      v-for="tab in tabs"
      :id="`panel-${tab.id}`"
      :key="tab.id"
      role="tabpanel"
      :aria-labelledby="`tab-${tab.id}`"
      :hidden="active !== tab.id"
    >
      <template v-if="active === tab.id">
        <pre v-if="build.ok" class="code-block" tabindex="0"><code>{{ code }}</code></pre>
        <p v-else class="hint">{{ build.error }}</p>
      </template>
    </div>
    <p class="hint note">
      The key is read from <code>$MOLOCHAI_API_KEY</code>; the playground never sends it to the
      browser. The Python version uses the official OpenAI SDK pointed at the MolochAI base URL.
    </p>
  </section>
</template>

<style scoped>
.tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 8px;
  border-bottom: 1px solid var(--border);
}

.tab {
  margin-bottom: -1px;
  padding: 6px 12px;
  border: 1px solid transparent;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--fg-2);
  font: inherit;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
}

.tab[aria-selected="true"] {
  border-bottom-color: var(--accent);
  color: var(--fg);
}

.note {
  margin-top: 8px;
}
</style>

<script setup lang="ts">
import { LINKS } from '../lib/links'
import { EXAMPLE_TOOLS, type Params } from '../lib/request'

const params = defineModel<Params>({ required: true })

// Starting values when a parameter is switched on; the model default applies while it is off.
const START = { temperature: 0.7, topP: 0.9 }

function toggle(key: 'temperature' | 'topP', on: boolean) {
  params.value[key] = on ? START[key] : null
}

function clamp(key: 'temperature' | 'topP', max: number, event: Event) {
  const input = event.target as HTMLInputElement
  const value = Number(input.value)
  if (input.value === '' || Number.isNaN(value)) return
  params.value[key] = Math.min(max, Math.max(0, value))
}

function insertExampleTools() {
  params.value.tools = EXAMPLE_TOOLS
}
</script>

<template>
  <section class="card" aria-labelledby="params-title">
    <div class="card-head">
      <h2 id="params-title">Parameters</h2>
    </div>
    <div class="stack">
      <fieldset class="param">
        <legend class="visually-hidden">temperature</legend>
        <label class="check">
          <input
            type="checkbox"
            :checked="params.temperature !== null"
            @change="toggle('temperature', ($event.target as HTMLInputElement).checked)"
          />
          <code>temperature</code>
        </label>
        <div class="row" v-if="params.temperature !== null">
          <input
            type="range"
            min="0"
            max="2"
            step="0.05"
            aria-label="temperature slider"
            :value="params.temperature"
            @input="clamp('temperature', 2, $event)"
          />
          <input
            type="number"
            class="num"
            min="0"
            max="2"
            step="0.05"
            aria-label="temperature value"
            :value="params.temperature"
            @change="clamp('temperature', 2, $event)"
          />
        </div>
        <p v-else class="hint">Not sent: the model default applies. Range 0 to 2.</p>
      </fieldset>

      <fieldset class="param">
        <legend class="visually-hidden">top_p</legend>
        <label class="check">
          <input
            type="checkbox"
            :checked="params.topP !== null"
            @change="toggle('topP', ($event.target as HTMLInputElement).checked)"
          />
          <code>top_p</code>
        </label>
        <div class="row" v-if="params.topP !== null">
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            aria-label="top_p slider"
            :value="params.topP"
            @input="clamp('topP', 1, $event)"
          />
          <input
            type="number"
            class="num"
            min="0"
            max="1"
            step="0.01"
            aria-label="top_p value"
            :value="params.topP"
            @change="clamp('topP', 1, $event)"
          />
        </div>
        <p v-else class="hint">Not sent: the model default applies. Range 0 to 1.</p>
      </fieldset>

      <label class="check">
        <input v-model="params.stream" type="checkbox" />
        Stream the response
      </label>
      <p class="hint" v-if="!params.stream">
        Plain requests that run longer than about 100 seconds can fail with a 524 edge timeout.
        Streaming avoids that and shows queue progress.
      </p>

      <details class="tools">
        <summary>Tools <span class="hint">(optional, OpenAI format)</span></summary>
        <div class="stack tools-body">
          <div>
            <label for="tools-json">tools (JSON array)</label>
            <textarea
              id="tools-json"
              v-model="params.tools"
              class="mono"
              rows="6"
              spellcheck="false"
              placeholder="[]"
            ></textarea>
          </div>
          <div class="row">
            <button type="button" class="btn btn-small" @click="insertExampleTools">Insert example</button>
            <button type="button" class="btn btn-small" :disabled="!params.tools" @click="params.tools = ''">
              Clear
            </button>
          </div>
          <div>
            <label for="tool-choice">tool_choice</label>
            <select id="tool-choice" v-model="params.toolChoice" :disabled="!params.tools.trim()">
              <option value="">not sent</option>
              <option value="auto">auto</option>
              <option value="none">none</option>
              <option value="required">required</option>
            </select>
          </div>
          <p class="hint">
            A reply that calls a tool ends with <code>finish_reason: tool_calls</code>. Add it to the
            conversation, fill in the tool result, and send again.
          </p>
        </div>
      </details>

      <div class="notice notice-plain">
        <p>
          <strong>Not offered on purpose.</strong> <code>max_tokens</code> has no effect (your plan's
          output cap per reply applies); <code>stop</code>, <code>seed</code> and
          <code>response_format</code> are ignored, and there is no JSON mode. Reasoning is fixed per
          model. <a :href="LINKS.docs" target="_blank" rel="noopener noreferrer">API docs</a>
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.param {
  display: grid;
  gap: 6px;
}

.num {
  flex: 0 0 84px;
  width: 84px;
}

.tools summary {
  font-weight: 650;
  cursor: pointer;
}

.tools-body {
  margin-top: 10px;
}
</style>

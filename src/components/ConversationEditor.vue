<script setup lang="ts">
import { computed, nextTick } from 'vue'
import { type EditorMessage, type EditorRole, newMessage } from '../lib/request'

const props = defineProps<{ running: boolean; formError: string | null }>()
const system = defineModel<string>('system', { required: true })
const messages = defineModel<EditorMessage[]>('messages', { required: true })
const emit = defineEmits<{ send: []; stop: []; reset: [] }>()

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)
const sendKeys = isMac ? '⌘ Enter' : 'Ctrl Enter'

const placeholders: Record<EditorRole, string> = {
  user: 'Ask something…',
  assistant: 'An earlier reply from the model (optional few-shot example).',
  tool: 'The tool result, usually JSON.',
}

const messageCount = computed(() => messages.value.length)

async function focusContent(id: number) {
  await nextTick()
  document.getElementById(`content-${id}`)?.focus()
}

function addMessage() {
  const last = messages.value.at(-1)
  const role: EditorRole = last?.role === 'user' ? 'assistant' : 'user'
  const message = newMessage(role)
  messages.value.push(message)
  focusContent(message.uid)
}

function removeMessage(index: number) {
  messages.value.splice(index, 1)
}

function onKeydown(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault()
    if (!props.running) emit('send')
  } else if (event.key === 'Escape' && props.running) {
    emit('stop')
  }
}

function toolNames(message: EditorMessage): string {
  return (message.toolCalls ?? []).map((call) => `${call.function.name} (${call.id})`).join(', ')
}

defineExpose({ focusContent })
</script>

<template>
  <section class="card span-all" aria-labelledby="conversation-title">
    <div class="card-head">
      <h2 id="conversation-title">Conversation</h2>
      <div class="actions">
        <button type="button" class="btn btn-small" :disabled="running" @click="emit('reset')">Reset</button>
      </div>
    </div>
    <form class="stack" novalidate @submit.prevent="!running && emit('send')" @keydown="onKeydown">
      <div>
        <label for="system-message">System message <span class="hint">(optional)</span></label>
        <textarea
          id="system-message"
          v-model="system"
          rows="3"
          placeholder="For example: Answer in one short paragraph."
        ></textarea>
        <p class="hint">The API places a short identity message above yours; yours is kept.</p>
      </div>

      <ol class="messages" aria-label="Messages">
        <li v-for="(message, index) in messages" :key="message.uid" class="message">
          <div class="message-head">
            <span class="index" aria-hidden="true">{{ index + 1 }}</span>
            <label :for="`role-${message.uid}`" class="visually-hidden">Role of message {{ index + 1 }}</label>
            <select :id="`role-${message.uid}`" v-model="message.role" class="role">
              <option value="user">user</option>
              <option value="assistant">assistant</option>
              <option value="tool">tool</option>
            </select>
            <template v-if="message.role === 'tool'">
              <label :for="`tool-id-${message.uid}`" class="visually-hidden">
                tool_call_id for message {{ index + 1 }}
              </label>
              <input
                :id="`tool-id-${message.uid}`"
                v-model="message.toolCallId"
                type="text"
                class="tool-id mono"
                placeholder="tool_call_id"
                spellcheck="false"
              />
            </template>
            <button
              type="button"
              class="btn btn-small delete"
              :aria-label="`Delete message ${index + 1}`"
              :disabled="running || messageCount === 1"
              @click="removeMessage(index)"
            >
              Delete
            </button>
          </div>
          <label :for="`content-${message.uid}`" class="visually-hidden">Content of message {{ index + 1 }}</label>
          <textarea
            :id="`content-${message.uid}`"
            v-model="message.content"
            rows="3"
            :placeholder="placeholders[message.role]"
          ></textarea>
          <p v-if="message.role === 'assistant' && message.toolCalls?.length" class="hint">
            Calls {{ toolNames(message) }}
            <button type="button" class="link-button" @click="message.toolCalls = undefined">Remove</button>
          </p>
          <p v-if="message.role === 'assistant' && message.reasoning" class="hint">
            Reasoning attached ({{ message.reasoning.length.toLocaleString('en-US') }} characters), sent back
            as <code>reasoning_content</code>.
            <button type="button" class="link-button" @click="message.reasoning = undefined">Remove</button>
          </p>
        </li>
      </ol>

      <div class="row">
        <button type="button" class="btn" :disabled="running" @click="addMessage">Add message</button>
      </div>

      <div class="send-row">
        <button v-if="!running" type="submit" class="btn btn-primary send">
          Send <kbd>{{ sendKeys }}</kbd>
        </button>
        <button v-else type="button" class="btn btn-stop" @click="emit('stop')">
          Stop <kbd>Esc</kbd>
        </button>
        <p v-if="formError" class="form-error" role="alert">{{ formError }}</p>
      </div>
    </form>
  </section>
</template>

<style scoped>
.messages {
  display: grid;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.message {
  display: grid;
  gap: 6px;
}

.message-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.index {
  min-width: 1.5em;
  color: var(--fg-2);
  font-size: 0.85rem;
  font-variant-numeric: tabular-nums;
}

.role {
  width: auto;
  min-width: 120px;
  padding: 4px 8px;
}

.tool-id {
  flex: 1 1 160px;
  width: auto;
  padding: 4px 8px;
  font-size: 0.82rem;
}

.delete {
  margin-left: auto;
}

.send-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}

.form-error {
  color: var(--danger);
  font-weight: 600;
}
</style>

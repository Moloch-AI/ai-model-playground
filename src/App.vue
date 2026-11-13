<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import CodeExport from './components/CodeExport.vue'
import ConversationEditor from './components/ConversationEditor.vue'
import LoginForm from './components/LoginForm.vue'
import ModelPicker from './components/ModelPicker.vue'
import ParamsPanel from './components/ParamsPanel.vue'
import ResponseStats from './components/ResponseStats.vue'
import ResponseView from './components/ResponseView.vue'
import { useRun } from './composables/useRun'
import { getAccessToken, getJson, RequestError, setAccessToken } from './lib/api'
import { splitCapNotice } from './lib/cap'
import type { ErrorInfo } from './lib/errors'
import { LINKS } from './lib/links'
import { buildChatRequest, defaultParams, type EditorMessage, newMessage, type Params } from './lib/request'
import { currentTheme, setTheme, type Theme } from './lib/theme'
import type { AccountInfo, ModelInfo } from './lib/types'

// Access
const authRequired = ref(false)
const tokenRejected = ref(false)
const hasToken = ref(getAccessToken() !== null)

// Models and account
const models = ref<ModelInfo[]>([])
const modelsLoading = ref(false)
const modelsError = ref<ErrorInfo | null>(null)
const account = ref<AccountInfo | null>(null)
const model = ref('')

// Editor
const system = ref('')
const messages = ref<EditorMessage[]>([newMessage('user')])
const params = ref<Params>(defaultParams())
const formError = ref<string | null>(null)
const editor = ref<InstanceType<typeof ConversationEditor> | null>(null)

// Run
const { state: run, run: start, stop, clear } = useRun()
const running = computed(() => run.status === 'waiting' || run.status === 'streaming')

const build = computed(() =>
  buildChatRequest({
    model: model.value,
    system: system.value,
    messages: messages.value,
    params: params.value,
  }),
)

const contextLimit = computed(() => {
  const entry = account.value?.models?.find((m) => m.id === model.value)
  if (entry && typeof entry.context_limit === 'number') return entry.context_limit
  return typeof account.value?.context_limit === 'number' ? account.value.context_limit : null
})

const theme = ref<Theme>(currentTheme())
function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  setTheme(theme.value)
}

function handleAuth(err: unknown): boolean {
  if (err instanceof RequestError && err.info.type === 'playground_auth_required') {
    tokenRejected.value = hasToken.value
    authRequired.value = true
    return true
  }
  return false
}

async function loadModels() {
  modelsLoading.value = true
  modelsError.value = null
  try {
    const list = await getJson<{ data?: ModelInfo[] }>('/api/models')
    models.value = Array.isArray(list.data) ? list.data.filter((m) => typeof m?.id === 'string') : []
    authRequired.value = false
    tokenRejected.value = false
    if (!models.value.some((m) => m.id === model.value)) pickDefaultModel()
  } catch (err) {
    if (handleAuth(err)) return
    modelsError.value = err instanceof RequestError ? err.info : null
  } finally {
    modelsLoading.value = false
  }
}

function pickDefaultModel() {
  const preferred = account.value?.default_model
  const available = models.value.filter((m) => m.available !== false)
  const choice = available.find((m) => m.id === preferred) ?? available[0] ?? models.value[0] ?? null
  model.value = choice?.id ?? ''
}

async function loadAccount() {
  try {
    account.value = await getJson<AccountInfo>('/api/account')
    if (!model.value || !models.value.some((m) => m.id === model.value)) pickDefaultModel()
  } catch (err) {
    // Not every OpenAI-compatible endpoint has /auth/me; the playground works without it.
    handleAuth(err)
    account.value = null
  }
}

async function load() {
  await loadModels()
  if (!authRequired.value) await loadAccount()
}

function login(token: string) {
  setAccessToken(token)
  hasToken.value = true
  void load()
}

function forgetToken() {
  setAccessToken(null)
  hasToken.value = false
  clear()
  authRequired.value = true
  tokenRejected.value = false
}

async function send() {
  if (running.value) return
  formError.value = null
  const result = build.value
  if (!result.ok) {
    formError.value = result.error
    return
  }
  await start(result.request)
  if (run.error?.type === 'playground_auth_required') {
    tokenRejected.value = true
    authRequired.value = true
  }
}

function appendReply() {
  const c = run.completion
  const content = splitCapNotice(c.content).content
  const calls = c.toolCalls.filter(Boolean)
  messages.value.push(
    newMessage('assistant', content, {
      reasoning: c.reasoning || undefined,
      toolCalls:
        calls.length > 0 ? calls.map((call) => ({ ...call, function: { ...call.function } })) : undefined,
    }),
  )
  if (calls.length > 0) {
    for (const call of calls) messages.value.push(newMessage('tool', '', { toolCallId: call.id }))
  } else {
    messages.value.push(newMessage('user'))
  }
  const last = messages.value.at(-1)
  if (last) editor.value?.focusContent(last.uid)
}

function resetConversation() {
  if (!window.confirm('Clear the system message, all messages and the response?')) return
  system.value = ''
  messages.value = [newMessage('user')]
  formError.value = null
  clear()
}

onMounted(load)
</script>

<template>
  <a class="skip-link" href="#main">Skip to the playground</a>
  <header class="app-header">
    <div class="brand">
      <svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
        <rect class="mark-bg" width="32" height="32" rx="7" />
        <path class="mark-fg" d="M8 23V9h3.2l4.8 7.4L20.8 9H24v14h-3.2v-8.6L16 21.6l-4.8-7.2V23Z" />
      </svg>
      <h1>MolochAI <span>Playground</span></h1>
    </div>
    <div class="header-actions">
      <p v-if="account?.plan || account?.tier" class="hint account">
        Plan <strong>{{ account.plan ?? account.tier }}</strong>
        <template v-if="account.plan_expires_at">
          · until {{ new Date(account.plan_expires_at).toLocaleDateString() }}</template
        >
      </p>
      <button
        type="button"
        class="btn btn-small"
        :aria-label="`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`"
        @click="toggleTheme"
      >
        {{ theme === 'dark' ? 'Light theme' : 'Dark theme' }}
      </button>
      <button v-if="hasToken" type="button" class="btn btn-small" @click="forgetToken">Forget token</button>
    </div>
  </header>

  <main id="main">
    <LoginForm v-if="authRequired" :rejected="tokenRejected" @submit="login" />
    <div v-else class="layout">
      <div class="sidebar">
        <ModelPicker
          v-model="model"
          :models="models"
          :loading="modelsLoading"
          :error="modelsError"
          :context-limit="contextLimit"
          @refresh="loadModels"
        />
        <ParamsPanel v-model="params" />
      </div>
      <div class="main">
        <ConversationEditor
          ref="editor"
          v-model:system="system"
          v-model:messages="messages"
          :running="running"
          :form-error="formError"
          @send="send"
          @stop="stop"
          @reset="resetConversation"
        />
        <ResponseView :run="run" @append="appendReply" />
        <ResponseStats :run="run" />
        <CodeExport :build="build" />
      </div>
    </div>
  </main>

  <footer class="app-footer">
    <p>
      The playground server keeps your API key; the browser only talks to that server. Replies come
      from less-restricted models: refusal behavior is reduced, they still sometimes decline, and they
      are not more accurate. The
      <a :href="LINKS.acceptableUse" target="_blank" rel="noopener noreferrer">Acceptable Use Policy</a>
      applies.
    </p>
    <nav aria-label="MolochAI links">
      <a :href="LINKS.docs" target="_blank" rel="noopener noreferrer">Docs</a>
      <a :href="LINKS.models" target="_blank" rel="noopener noreferrer">Models</a>
      <a :href="LINKS.pricing" target="_blank" rel="noopener noreferrer">Pricing</a>
      <a :href="LINKS.apiKeys" target="_blank" rel="noopener noreferrer">API keys</a>
      <a :href="LINKS.contact" target="_blank" rel="noopener noreferrer">Contact</a>
      <a :href="LINKS.source" target="_blank" rel="noopener noreferrer">Source</a>
    </nav>
  </footer>
</template>

<style scoped>
.account {
  margin-right: 4px;
}

.account strong {
  color: var(--fg);
}

.mark-bg {
  fill: var(--accent);
}

.mark-fg {
  fill: var(--accent-fg);
}
</style>

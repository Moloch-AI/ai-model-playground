<script setup lang="ts">
import { onMounted, ref } from 'vue'

defineProps<{ rejected: boolean }>()
const emit = defineEmits<{ submit: [token: string] }>()

const token = ref('')
const input = ref<HTMLInputElement | null>(null)

onMounted(() => input.value?.focus())

function submit() {
  const value = token.value.trim()
  if (value) emit('submit', value)
}
</script>

<template>
  <section class="card login" aria-labelledby="login-title">
    <h2 id="login-title">Access token</h2>
    <form class="stack" @submit.prevent="submit">
      <p>
        This playground server requires an access token (<code>PLAYGROUND_ACCESS_TOKEN</code>). Ask
        whoever runs it. The token stays in this tab's session storage and is cleared when the tab closes.
      </p>
      <div>
        <label for="access-token">Token</label>
        <input
          id="access-token"
          ref="input"
          v-model="token"
          type="password"
          autocomplete="current-password"
          spellcheck="false"
          :aria-invalid="rejected"
          :aria-describedby="rejected ? 'access-token-error' : undefined"
        />
      </div>
      <p v-if="rejected" id="access-token-error" class="error" role="alert">
        That token was not accepted. Check it and try again.
      </p>
      <div class="row">
        <button type="submit" class="btn btn-primary" :disabled="!token.trim()">Continue</button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.login {
  max-width: 480px;
  margin: 48px auto;
}

.login h2 {
  margin-bottom: 12px;
}

.error {
  color: var(--danger);
  font-weight: 600;
}
</style>

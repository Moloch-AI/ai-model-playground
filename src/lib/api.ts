// Calls to the playground server. The browser never sees the API key; when the server requires
// an access token, it is kept in sessionStorage (cleared when the tab closes) and sent as a
// bearer token to this server only.

import { describeHttpError, describeNetworkError, type ErrorInfo } from './errors'
import { readStorage, writeStorage } from './storage'

const TOKEN_KEY = 'molochai-playground:access-token'

export function getAccessToken(): string | null {
  return readStorage('session', TOKEN_KEY)
}

export function setAccessToken(token: string | null): void {
  writeStorage('session', TOKEN_KEY, token)
}

export class RequestError extends Error {
  readonly info: ErrorInfo

  constructor(info: ErrorInfo) {
    super(info.title)
    this.info = info
  }
}

export type Fetcher = (path: string, init?: RequestInit) => Promise<Response>

export const apiFetch: Fetcher = (path, init = {}) => {
  const headers = new Headers(init.headers)
  const token = getAccessToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  return fetch(path, { ...init, headers, credentials: 'same-origin', cache: 'no-store' })
}

/** GET a JSON endpoint; failures throw RequestError with a described error. */
export async function getJson<T>(path: string, fetcher: Fetcher = apiFetch): Promise<T> {
  let res: Response
  try {
    res = await fetcher(path)
  } catch {
    throw new RequestError(describeNetworkError())
  }
  const text = await res.text().catch(() => '')
  if (!res.ok) throw new RequestError(describeHttpError(res.status, text, res.headers))
  try {
    return JSON.parse(text) as T
  } catch {
    throw new RequestError(describeHttpError(502, text, res.headers))
  }
}

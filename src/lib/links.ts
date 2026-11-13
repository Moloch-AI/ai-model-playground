// Links to molochai.dev and dash.molochai.dev carry campaign parameters so the site can tell
// visits from this playground apart. API URLs are never tagged.

export const UTM = 'utm_source=github&utm_medium=oss&utm_campaign=ai-model-playground'

const TAGGED_HOSTS = new Set(['molochai.dev', 'dash.molochai.dev'])

/** Add the campaign parameters to a molochai.dev or dash.molochai.dev URL (before any #fragment). */
export function tagged(url: string): string {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return url
  }
  if (!TAGGED_HOSTS.has(host)) return url
  const hashAt = url.indexOf('#')
  const base = hashAt === -1 ? url : url.slice(0, hashAt)
  const hash = hashAt === -1 ? '' : url.slice(hashAt)
  return `${base}${base.includes('?') ? '&' : '?'}${UTM}${hash}`
}

export const LINKS = {
  site: tagged('https://molochai.dev'),
  docs: tagged('https://molochai.dev/docs'),
  models: tagged('https://molochai.dev/models'),
  pricing: tagged('https://molochai.dev/pricing'),
  contact: tagged('https://molochai.dev/contact'),
  acceptableUse: tagged('https://molochai.dev/acceptable-use'),
  dashboard: tagged('https://dash.molochai.dev'),
  apiKeys: tagged('https://dash.molochai.dev/account'),
  source: 'https://github.com/Moloch-AI/ai-model-playground',
} as const

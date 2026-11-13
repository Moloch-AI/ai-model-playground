/// <reference lib="dom" />
import { expect, type Page, test } from '@playwright/test'

// Every console error (CSP violations included: Chromium logs them as errors) fails a test.
function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

async function open(page: Page) {
  await page.goto('/')
  await expect(page.locator('#model-select')).toHaveValue('glm-5.3-flash')
}

async function send(page: Page, text: string) {
  const box = page.locator('textarea[id^="content-"]').last()
  await box.fill(text)
  await box.press('Control+Enter')
}

test('loads under the strict CSP with self-hosted fonts and the model list', async ({ page }) => {
  const errors = trackConsoleErrors(page)
  await open(page)
  await expect(page.locator('#model-select option')).toHaveCount(5)
  await expect(page.locator('#model-select option', { hasText: '(unavailable)' })).toHaveCount(1)
  await expect(page.locator('.account')).toContainText('pro')
  const fontsLoaded = await page.evaluate(async () => {
    await document.fonts.load('16px "Instrument Sans Variable"')
    await document.fonts.load('16px "JetBrains Mono Variable"')
    return (
      document.fonts.check('16px "Instrument Sans Variable"') &&
      document.fonts.check('16px "JetBrains Mono Variable"')
    )
  })
  expect(fontsLoaded).toBe(true)
  expect(errors).toEqual([])
})

test('streams reasoning and answer, with response info', async ({ page }) => {
  const errors = trackConsoleErrors(page)
  await open(page)
  await send(page, 'Hello from the browser [mock:queue]')
  await expect(page.locator('.status')).toHaveText(/^Done/, { timeout: 15_000 })
  await expect(page.locator('.answer .text-block')).toHaveText(
    'Mock reply from glm-5.3-flash: Hello from the browser [mock:queue]',
  )
  await page.locator('details.reasoning summary').click()
  await expect(page.locator('details.reasoning')).toContainText('Mock reasoning for glm-5.3-flash.')
  const stats = page.locator('.stats')
  await expect(stats).toContainText('stop')
  await expect(stats).toContainText('queued · position 1 of 3')
  await expect(stats).toContainText('of 60 per minute')
  expect(errors).toEqual([])
})

test('shows the cap notice apart from the answer', async ({ page }) => {
  await open(page)
  await send(page, 'Long one [mock:cap]')
  await expect(page.locator('.notice-warning')).toContainText(
    '[Response is too large for your current plan. Try a smaller request.]',
  )
  await expect(page.locator('.answer .text-block')).not.toContainText('Response is too large')
})

test('explains API errors, including model_unavailable', async ({ page }) => {
  await open(page)
  await send(page, 'Too long [mock:context]')
  const panel = page.locator('.response .error-panel')
  await expect(panel).toContainText('The prompt is longer than the context limit')
  await expect(panel).toContainText('65,536 tokens')
  await page.locator('#model-select').selectOption('llama-3.3-70b-instruct-abliterated')
  await expect(page.getByText('No server is serving this model right now.')).toBeVisible()
  await send(page, 'Hi')
  await expect(panel).toContainText('model_unavailable')
})

test('stops a slow request', async ({ page }) => {
  await open(page)
  await send(page, 'Wait [mock:slow=10000]')
  const stop = page.getByRole('button', { name: /^Stop/ })
  await expect(stop).toBeVisible()
  await stop.click()
  await expect(page.locator('.status')).toHaveText(/^Stopped/)
})

test('keeps the theme choice across reloads', async ({ page }) => {
  await open(page)
  const before = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  await page.getByRole('button', { name: /Switch to (light|dark) theme/ }).click()
  const theme = await page.evaluate(() => document.documentElement.dataset.theme ?? '')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  const after = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  expect(after).not.toBe(before)
})

test('fits a 360 px wide screen without horizontal scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 })
  await open(page)
  await send(page, 'A reply on a phone')
  await expect(page.locator('.status')).toHaveText(/^Done/, { timeout: 15_000 })
  await page.locator('details.tools summary').click()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})

test('is usable from the keyboard', async ({ page }) => {
  await open(page)
  await page.keyboard.press('Tab')
  const skip = page.getByRole('link', { name: 'Skip to the playground' })
  await expect(skip).toBeFocused()
  const outline = await skip.evaluate((element) => getComputedStyle(element).outlineStyle)
  expect(outline).toBe('solid')
  // Send from the keyboard alone: focus the message box, type, Ctrl+Enter.
  await page.locator('textarea[id^="content-"]').focus()
  await page.keyboard.type('Typed with the keyboard')
  await page.keyboard.press('Control+Enter')
  await expect(page.locator('.status')).toHaveText(/^Done/, { timeout: 15_000 })
})

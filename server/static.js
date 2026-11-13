// @ts-check
// Serves the built SPA from dist/. No directory listings, no paths outside the root.

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'

const TYPES = /** @type {Record<string, string>} */ ({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
})

/**
 * @param {string} rootDir  absolute path of the built SPA
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, pathname: string) => Promise<void>}
 */
export function createStaticHandler(rootDir) {
  const root = path.resolve(rootDir)

  return async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Method not allowed.\n')
      return
    }

    let decoded
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      return notFound(res)
    }
    if (decoded.includes('\0') || decoded.includes('\\')) return notFound(res)
    const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
    const file = path.resolve(root, relative)
    if (file !== root && !file.startsWith(root + path.sep)) return notFound(res)

    let info
    try {
      info = await stat(file)
    } catch {
      if (relative === 'index.html') {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('The UI is not built yet. Run "npm run build", or use "npm run dev".\n')
        return
      }
      return notFound(res)
    }
    if (!info.isFile()) return notFound(res)

    const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
    const immutable = relative.startsWith('assets/')
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': String(info.size),
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res)
  }
}

/** @param {import('node:http').ServerResponse} res */
function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('Not found.\n')
}

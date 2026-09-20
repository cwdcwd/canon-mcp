#!/usr/bin/env node
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { mimeFor, resolveScan } from './files.ts'
import { createServer } from './mcp.ts'
import { handleRest } from './rest.ts'

const port = Number(process.env.PORT ?? 3000)
const host = process.env.HOST ?? '0.0.0.0'
const token = process.env.MCP_TOKEN
const path = process.env.MCP_PATH ?? '/mcp'
// Set PUBLIC_BASE_URL when behind a proxy or tunnel; otherwise the request's
// own Host header is used to build download URLs.
const publicBaseUrl = process.env.PUBLIC_BASE_URL

const readBody = (req: IncomingMessage) =>
  new Promise<unknown>((res, rej) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      if (!raw) return res(undefined)
      try {
        res(JSON.parse(raw))
      } catch {
        rej(new Error('invalid JSON body'))
      }
    })
    req.on('error', rej)
  })

const rpcError = (code: number, message: string) =>
  JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null })

const authorized = (req: IncomingMessage) => {
  if (!token) return true
  if (req.headers.authorization === `Bearer ${token}`) return true
  // Convenience for browsers and curl: ?token=... on file downloads only
  return new URL(req.url ?? '/', 'http://x').searchParams.get('token') === token
}

const baseUrlFor = (req: IncomingMessage) =>
  publicBaseUrl ?? (req.headers.host ? `http://${req.headers.host}` : undefined)

const serveFile = async (req: IncomingMessage, res: ServerResponse) => {
  const name = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname.slice('/files/'.length))
  let filePath: string
  try {
    filePath = resolveScan(name)
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' })
    return res.end('bad file name\n')
  }

  const info = await stat(filePath).catch(() => undefined)
  if (!info?.isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    return res.end('not found\n')
  }

  res.writeHead(200, {
    'content-type': mimeFor(name),
    'content-length': info.size,
    'content-disposition': `inline; filename="${name}"`,
    'cache-control': 'no-store',
  })
  if (req.method === 'HEAD') return res.end()
  createReadStream(filePath).pipe(res)
}

const http = createHttpServer(async (req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://x').pathname

  if (pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ok: true }))
  }

  if (pathname.startsWith('/api/')) {
    if (!authorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'unauthorized' }))
    }
    if (await handleRest(req, res, pathname, baseUrlFor(req))) return
  }

  if (pathname.startsWith('/files/')) {
    if (!authorized(req)) {
      res.writeHead(401, { 'content-type': 'text/plain' })
      return res.end('unauthorized\n')
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      return res.end()
    }
    return serveFile(req, res)
  }

  if (pathname !== path) {
    res.writeHead(404)
    return res.end()
  }

  if (token && req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401, { 'content-type': 'application/json' })
    return res.end(rpcError(-32001, 'unauthorized'))
  }

  // Stateless: a fresh server and transport per request, so restarts and
  // multiple agents don't step on each other
  const server = createServer({ baseUrl: baseUrlFor(req) })
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })

  try {
    await server.connect(transport)
    await transport.handleRequest(req, res, req.method === 'POST' ? await readBody(req) : undefined)
  } catch (err) {
    console.error('request failed:', err)
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
    if (!res.writableEnded) res.end(rpcError(-32603, 'internal error'))
  }
})

http.listen(port, host, () => {
  console.error(`canon-mcp listening on http://${host}:${port} — MCP at ${path}, REST at /api${token ? ' (bearer auth on)' : ' (NO AUTH)'}`)
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => http.close(() => process.exit(0)))
}

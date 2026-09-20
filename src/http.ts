#!/usr/bin/env node
import { createServer as createHttpServer } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createServer } from './mcp.ts'

const port = Number(process.env.PORT ?? 3000)
const host = process.env.HOST ?? '0.0.0.0'
const token = process.env.MCP_TOKEN
const path = process.env.MCP_PATH ?? '/mcp'

const readBody = (req: import('node:http').IncomingMessage) =>
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

const http = createHttpServer(async (req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ok: true }))
  }

  if (!req.url?.startsWith(path)) {
    res.writeHead(404)
    return res.end()
  }

  if (token && req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401, { 'content-type': 'application/json' })
    return res.end(rpcError(-32001, 'unauthorized'))
  }

  // Stateless: a fresh server and transport per request, so restarts and
  // multiple agents don't step on each other
  const server = createServer()
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
  console.error(`canon-mcp listening on http://${host}:${port}${path}${token ? ' (bearer auth on)' : ' (NO AUTH)'}`)
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => http.close(() => process.exit(0)))
}

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { writeFile } from 'node:fs/promises'
import { deleteScan, listScans, mimeFor, resolveScan } from './files.ts'
import { getJob, listJobs, startJob } from './jobs.ts'
import { cancelPrintJob, listPrintJobs, listPrinters, printFile, printerStatus } from './printer.ts'
import { listDevices, scan, type ScanResult } from './scanner.ts'

const scanBody = z.object({
  resolution: z.union([z.literal(75), z.literal(150), z.literal(300), z.literal(600)]).default(300),
  mode: z.enum(['Color', 'Gray', 'Lineart']).default('Color'),
  source: z.enum(['Flatbed', 'ADF']).default('Flatbed'),
  format: z.enum(['png', 'jpeg', 'tiff', 'pdf']).default('pdf'),
  name: z.string().regex(/^[\w .-]+$/).optional(),
  device: z.string().optional(),
}).strict()

const printBody = z.object({
  scan: z.string().optional(),
  content: z.string().optional(),
  filename: z.string().regex(/^[\w .-]+$/).optional(),
  copies: z.number().int().min(1).max(20).default(1),
  color: z.enum(['color', 'monochrome']).default('color'),
  quality: z.enum(['draft', 'normal', 'high']).default('normal'),
  media: z.string().optional(),
  pages: z.string().regex(/^[\d,-]+$/).optional(),
  fit_to_page: z.boolean().default(true),
}).strict().refine(b => b.scan || b.content, { message: 'give either scan or content' })

const copyBody = z.object({
  resolution: z.union([z.literal(150), z.literal(300), z.literal(600)]).default(300),
  mode: z.enum(['Color', 'Gray', 'Lineart']).default('Color'),
  source: z.enum(['Flatbed', 'ADF']).default('Flatbed'),
  copies: z.number().int().min(1).max(20).default(1),
  quality: z.enum(['draft', 'normal', 'high']).default('normal'),
}).strict()

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  const payload = JSON.stringify(body, null, 2)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers })
  res.end(payload)
}

const readJson = (req: IncomingMessage) =>
  new Promise<unknown>((resolve, reject) => {
    let raw = ''
    req.on('data', c => {
      raw += c
      if (raw.length > 64_000) reject(new Error('body too large'))
    })
    req.on('end', () => {
      if (!raw.trim()) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })

const withUrls = (result: ScanResult, baseUrl?: string) => ({
  ...result,
  files: result.files.map(f => {
    const name = f.path.split('/').pop() ?? f.path
    return {
      ...f,
      name,
      uri: `scan://${name}`,
      url: baseUrl ? `${baseUrl}/api/scans/${encodeURIComponent(name)}` : undefined,
    }
  }),
})

const sendFile = async (req: IncomingMessage, res: ServerResponse, name: string, download: boolean) => {
  let path: string
  try {
    path = resolveScan(name)
  } catch {
    return json(res, 400, { error: 'bad file name' })
  }
  const info = await stat(path).catch(() => undefined)
  if (!info?.isFile()) return json(res, 404, { error: 'not found' })

  res.writeHead(200, {
    'content-type': mimeFor(name),
    'content-length': info.size,
    'content-disposition': `${download ? 'attachment' : 'inline'}; filename="${name}"`,
    'cache-control': 'no-store',
  })
  if (req.method === 'HEAD') return res.end()
  createReadStream(path).pipe(res)
}

/**
 * REST routes under /api. Returns false when the path isn't ours, so the
 * caller can fall through to the MCP endpoint.
 * Auth is handled by the caller — everything here is already authorized.
 */
export const handleRest = async (
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  baseUrl?: string,
): Promise<boolean> => {
  if (!pathname.startsWith('/api/')) return false
  const method = req.method ?? 'GET'
  const url = new URL(req.url ?? '/', 'http://x')
  const segments = pathname.slice('/api/'.length).split('/').filter(Boolean)
  const [collection, id] = segments

  try {
    if (collection === 'scanners' && !id) {
      if (method !== 'GET') return json(res, 405, { error: 'method not allowed' }), true
      return json(res, 200, await listDevices()), true
    }

    if (collection === 'scans' && !id) {
      if (method === 'GET') {
        const files = (await listScans()).map(f => ({
          ...f,
          uri: `scan://${f.name}`,
          url: baseUrl ? `${baseUrl}/api/scans/${encodeURIComponent(f.name)}` : undefined,
        }))
        return json(res, 200, files), true
      }

      if (method === 'POST') {
        const parsed = scanBody.safeParse(await readJson(req))
        if (!parsed.success) {
          return json(res, 422, { error: 'invalid body', details: parsed.error.issues }), true
        }
        const opts = parsed.data
        // ?wait=false returns immediately with a job to poll; the default
        // holds the connection until the scan finishes (~45s at 300 dpi color)
        const wait = url.searchParams.get('wait') !== 'false'

        if (!wait) {
          const job = startJob(onProgress => scan({ ...opts, onProgress }))
          const location = baseUrl ? `${baseUrl}/api/jobs/${job.id}` : `/api/jobs/${job.id}`
          return json(res, 202, { ...job, url: location }, { location }), true
        }

        const result = withUrls(await scan(opts), baseUrl)
        const first = result.files[0]
        const location = first?.url
        return json(res, 201, result, location ? { location } : {}), true
      }

      return json(res, 405, { error: 'method not allowed' }), true
    }

    if (collection === 'scans' && id) {
      const name = decodeURIComponent(id)
      if (method === 'GET' || method === 'HEAD') {
        await sendFile(req, res, name, url.searchParams.get('download') === 'true')
        return true
      }
      if (method === 'DELETE') {
        try {
          await deleteScan(name)
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code
          if (code === 'ENOENT') return json(res, 404, { error: 'not found' }), true
          throw err
        }
        res.writeHead(204)
        res.end()
        return true
      }
      return json(res, 405, { error: 'method not allowed' }), true
    }

    if (collection === 'printers' && !id) {
      if (method !== 'GET') return json(res, 405, { error: 'method not allowed' }), true
      return json(res, 200, { printers: await listPrinters(), status: await printerStatus() }), true
    }

    if (collection === 'print') {
      const sub = segments[1]

      // POST /api/print — print a scan or base64 content
      if (!sub && method === 'POST') {
        const parsed = printBody.safeParse(await readJson(req))
        if (!parsed.success) return json(res, 422, { error: 'invalid body', details: parsed.error.issues }), true
        const b = parsed.data

        let path: string
        if (b.scan) {
          try {
            path = resolveScan(b.scan)
          } catch {
            return json(res, 400, { error: 'bad file name' }), true
          }
        } else {
          path = `/tmp/${Date.now()}-${b.filename ?? 'print.pdf'}`
          await writeFile(path, Buffer.from(b.content ?? '', 'base64'))
        }

        const job = await printFile(path, {
          copies: b.copies,
          colorMode: b.color,
          quality: b.quality,
          media: b.media,
          pages: b.pages,
          fitToPage: b.fit_to_page,
          title: b.scan ?? b.filename,
        })
        const location = baseUrl ? `${baseUrl}/api/print/jobs` : '/api/print/jobs'
        return json(res, 202, job, { location }), true
      }

      // GET /api/print/jobs, DELETE /api/print/jobs/<id>
      if (sub === 'jobs') {
        const jobId = segments[2]
        if (method === 'GET' && !jobId) return json(res, 200, await listPrintJobs()), true
        if (method === 'DELETE' && jobId) {
          await cancelPrintJob(decodeURIComponent(jobId))
          res.writeHead(204)
          res.end()
          return true
        }
      }

      // POST /api/print/copies — scan and print in one step
      if (sub === 'copies' && method === 'POST') {
        const parsed = copyBody.safeParse(await readJson(req))
        if (!parsed.success) return json(res, 422, { error: 'invalid body', details: parsed.error.issues }), true
        const b = parsed.data
        const result = await scan({
          resolution: b.resolution,
          mode: b.mode,
          source: b.source,
          format: 'pdf',
          name: `copy-${Date.now()}`,
        })
        const printed = []
        for (const file of result.files) {
          printed.push(await printFile(file.path, {
            copies: b.copies,
            colorMode: b.mode === 'Color' ? 'color' : 'monochrome',
            quality: b.quality,
            title: 'copy',
          }))
        }
        return json(res, 202, { scanned: withUrls(result, baseUrl).files, printed }), true
      }

      return json(res, 405, { error: 'method not allowed' }), true
    }

    if (collection === 'jobs') {
      if (method !== 'GET') return json(res, 405, { error: 'method not allowed' }), true
      if (!id) return json(res, 200, listJobs()), true
      const job = getJob(id)
      if (!job) return json(res, 404, { error: 'not found' }), true
      const result = job.status === 'done' && job.result
        ? withUrls(job.result as ScanResult, baseUrl)
        : undefined
      return json(res, 200, { ...job, result }), true
    }

    return json(res, 404, { error: 'not found' }), true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return json(res, 500, { error: message }), true
  }
}

import { readFile } from 'node:fs/promises'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { listScans, mimeFor, resolveScan } from './files.ts'
import { cancelPrintJob, listPrintJobs, printFile, printerStatus } from './printer.ts'
import { config, deviceOptions, listDevices, scan } from './scanner.ts'

export type ServerOptions = {
  /** Base URL this server is reachable at, e.g. http://pi.local:3000. Enables download URLs. */
  baseUrl?: string
}

const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
})

const INLINE_LIMIT = 4_000_000

export const createServer = (opts: ServerOptions = {}) => {
  const server = new McpServer({ name: 'canon-mcp', version: '0.5.0' })
  const downloadUrl = (name: string) => opts.baseUrl ? `${opts.baseUrl}/files/${encodeURIComponent(name)}` : undefined

  server.registerTool(
    'list_scanners',
    {
      title: 'List scanners',
      description: 'List SANE scanners reachable from the host running this server',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return { content: [{ type: 'text', text: JSON.stringify(await listDevices(), null, 2) }] }
      } catch (err) {
        return fail(err)
      }
    },
  )

  server.registerTool(
    'scanner_options',
    {
      title: 'Scanner options',
      description: 'Show supported options (resolutions, modes, sources, scan area) for a scanner',
      inputSchema: { device: z.string().optional().describe('SANE device name; defaults to the first found') },
      annotations: { readOnlyHint: true },
    },
    async ({ device }) => {
      try {
        return { content: [{ type: 'text', text: await deviceOptions(device) }] }
      } catch (err) {
        return fail(err)
      }
    },
  )

  server.registerTool(
    'list_scans',
    {
      title: 'List scans',
      description: `List files already in the scan directory (${config.outputDir}), newest first`,
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const files = (await listScans()).map(f => ({ ...f, uri: `scan://${f.name}`, url: downloadUrl(f.name) }))
        return { content: [{ type: 'text', text: JSON.stringify(files, null, 2) }] }
      } catch (err) {
        return fail(err)
      }
    },
  )

  server.registerTool(
    'scan_document',
    {
      title: 'Scan document',
      description: `Scan from the flatbed or document feeder and save to ${config.outputDir} on the server host. A 300 dpi color page takes about 45 seconds over Wi-Fi. Each file comes back with a scan:// resource URI${opts.baseUrl ? ' and an HTTP download URL' : ''}; set return_file to also get the bytes inline (images and PDFs under 4MB).`,
      inputSchema: {
        resolution: z.union([z.literal(75), z.literal(150), z.literal(300), z.literal(600)]).default(300),
        mode: z.enum(['Color', 'Gray', 'Lineart']).default('Color'),
        source: z.enum(['Flatbed', 'ADF']).default('Flatbed').describe('ADF scans every page in the feeder'),
        format: z.enum(['png', 'jpeg', 'tiff', 'pdf']).default('pdf'),
        name: z.string().regex(/^[\w .-]+$/).optional().describe('Base filename without extension'),
        output_dir: z.string().optional(),
        device: z.string().optional(),
        return_file: z.boolean().default(false).describe('Return file contents inline; skipped for files over 4MB'),
      },
    },
    async (args, extra) => {
      const token = extra._meta?.progressToken
      try {
        const result = await scan({
          resolution: args.resolution,
          mode: args.mode,
          source: args.source,
          format: args.format,
          name: args.name,
          outputDir: args.output_dir,
          device: args.device,
          onProgress: token === undefined
            ? undefined
            : pct => void extra.sendNotification({
              method: 'notifications/progress',
              params: { progressToken: token, progress: pct, total: 100 },
            }),
        })

        const files = result.files.map(f => {
          const name = f.path.split('/').pop() ?? f.path
          return { ...f, name, uri: `scan://${name}`, url: downloadUrl(name) }
        })

        const content: Record<string, unknown>[] = [
          { type: 'text', text: JSON.stringify({ ...result, files }, null, 2) },
        ]

        for (const file of files) {
          content.push({ type: 'resource_link', uri: `scan://${file.name}`, name: file.name, mimeType: mimeFor(file.name) })
          if (!args.return_file) continue
          if (file.bytes > INLINE_LIMIT) {
            content.push({
              type: 'text',
              text: `${file.name} is ${(file.bytes / 1e6).toFixed(1)}MB, over the 4MB inline limit. Read scan://${file.name}${file.url ? `, fetch ${file.url},` : ''} or rescan at a lower resolution.`,
            })
            continue
          }
          const data = (await readFile(file.path)).toString('base64')
          const mime = mimeFor(file.name)
          content.push(mime.startsWith('image/') && mime !== 'image/tiff'
            ? { type: 'image', data, mimeType: mime }
            : { type: 'resource', resource: { uri: `scan://${file.name}`, mimeType: mime, blob: data } })
        }

        return { content } as never
      } catch (err) {
        return fail(err)
      }
    },
  )

  const printInput = {
    scan: z.string().optional().describe('Filename of an existing scan to print'),
    content: z.string().optional().describe('Base64 file contents, when printing something not on the server'),
    filename: z.string().regex(/^[\w .-]+$/).optional().describe('Filename for base64 content; the extension matters'),
    copies: z.number().int().min(1).max(20).default(1),
    color: z.enum(['color', 'monochrome']).default('color'),
    quality: z.enum(['draft', 'normal', 'high']).default('normal'),
    media: z.string().optional().describe('Paper size, e.g. na_letter_8.5x11in (printer default if unset)'),
    pages: z.string().regex(/^[\d,-]+$/).optional().describe('Page range, e.g. 1-3,7'),
    fit_to_page: z.boolean().default(true),
  }

  const resolvePrintable = async (args: { scan?: string, content?: string, filename?: string }) => {
    if (args.scan) return resolveScan(args.scan)
    if (!args.content) throw new Error('give either scan (a file on the server) or content (base64)')
    const name = args.filename ?? 'print.pdf'
    const path = `/tmp/${Date.now()}-${name}`
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, Buffer.from(args.content, 'base64'))
    return path
  }

  server.registerTool(
    'printer_status',
    {
      title: 'Printer status',
      description: 'Printer state, model, ink levels and queue depth',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return { content: [{ type: 'text', text: JSON.stringify(await printerStatus(), null, 2) }] }
      } catch (err) {
        return fail(err)
      }
    },
  )

  server.registerTool(
    'print_file',
    {
      title: 'Print',
      description: 'Print a scan already on the server, or base64 content. Uses paper and ink. PDFs are rasterized by CUPS, since this printer only accepts JPEG and raster formats.',
      inputSchema: printInput,
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async args => {
      try {
        const path = await resolvePrintable(args)
        const job = await printFile(path, {
          copies: args.copies,
          colorMode: args.color,
          quality: args.quality,
          media: args.media,
          pages: args.pages,
          fitToPage: args.fit_to_page,
          title: args.scan ?? args.filename,
        })
        return { content: [{ type: 'text', text: JSON.stringify(job, null, 2) }] }
      } catch (err) {
        return fail(err)
      }
    },
  )

  server.registerTool(
    'print_jobs',
    {
      title: 'Print queue',
      description: 'List queued and printing jobs',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return { content: [{ type: 'text', text: JSON.stringify(await listPrintJobs(), null, 2) }] }
      } catch (err) {
        return fail(err)
      }
    },
  )

  server.registerTool(
    'cancel_print_job',
    {
      title: 'Cancel print job',
      description: 'Cancel a queued or printing job by id (e.g. MX490-7)',
      inputSchema: { job_id: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ job_id }) => {
      try {
        await cancelPrintJob(job_id)
        return { content: [{ type: 'text', text: `cancelled ${job_id}` }] }
      } catch (err) {
        return fail(err)
      }
    },
  )

  server.registerTool(
    'copy_document',
    {
      title: 'Copy',
      description: 'Scan a page and print it in one step, like a copier. Uses paper and ink.',
      inputSchema: {
        resolution: z.union([z.literal(150), z.literal(300), z.literal(600)]).default(300),
        mode: z.enum(['Color', 'Gray', 'Lineart']).default('Color'),
        source: z.enum(['Flatbed', 'ADF']).default('Flatbed'),
        copies: z.number().int().min(1).max(20).default(1),
        quality: z.enum(['draft', 'normal', 'high']).default('normal'),
      },
    },
    async (args, extra) => {
      const token = extra._meta?.progressToken
      try {
        const result = await scan({
          resolution: args.resolution,
          mode: args.mode,
          source: args.source,
          format: 'pdf',
          name: `copy-${Date.now()}`,
          onProgress: token === undefined
            ? undefined
            : pct => void extra.sendNotification({
              method: 'notifications/progress',
              params: { progressToken: token, progress: pct, total: 100 },
            }),
        })
        const jobs = []
        for (const file of result.files) {
          jobs.push(await printFile(file.path, {
            copies: args.copies,
            colorMode: args.mode === 'Color' ? 'color' : 'monochrome',
            quality: args.quality,
            title: 'copy',
          }))
        }
        return { content: [{ type: 'text', text: JSON.stringify({ scanned: result.files, printed: jobs }, null, 2) }] }
      } catch (err) {
        return fail(err)
      }
    },
  )

  // Every file in the scan directory is readable as scan://<filename>, so an
  // agent can pull one on demand instead of carrying bytes through every scan.
  server.registerResource(
    'scan',
    new ResourceTemplate('scan://{name}', {
      list: async () => ({
        resources: (await listScans()).map(f => ({
          uri: `scan://${f.name}`,
          name: f.name,
          title: f.name,
          mimeType: f.mimeType,
          description: `${(f.bytes / 1000).toFixed(0)}KB, scanned ${f.modified}`,
        })),
      }),
    }),
    { title: 'Scanned file', description: 'A file in the scan directory' },
    async (uri, { name }) => {
      const file = Array.isArray(name) ? name[0] : name
      const path = resolveScan(decodeURIComponent(file))
      const mimeType = mimeFor(file)
      return {
        contents: [{ uri: uri.href, mimeType, blob: (await readFile(path)).toString('base64') }],
      }
    },
  )

  return server
}

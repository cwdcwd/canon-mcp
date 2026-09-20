import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { config, deviceOptions, listDevices, scan } from './scanner.ts'

const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
})

export const createServer = () => {
  const server = new McpServer({ name: 'canon-mcp', version: '0.2.0' })

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
    'scan_document',
    {
      title: 'Scan document',
      description: `Scan from the flatbed or document feeder and save to disk on the server host (${config.outputDir} unless output_dir is given). A 300 dpi color page takes about 45 seconds over Wi-Fi. Set return_file to get the bytes back inline.`,
      inputSchema: {
        resolution: z.union([z.literal(75), z.literal(150), z.literal(300), z.literal(600)]).default(300),
        mode: z.enum(['Color', 'Gray', 'Lineart']).default('Color'),
        source: z.enum(['Flatbed', 'ADF']).default('Flatbed').describe('ADF scans every page in the feeder'),
        format: z.enum(['png', 'jpeg', 'tiff', 'pdf']).default('pdf'),
        name: z.string().regex(/^[\w .-]+$/).optional().describe('Base filename without extension'),
        output_dir: z.string().optional(),
        device: z.string().optional(),
        return_file: z.boolean().default(false).describe('Return file contents inline; only for images under ~4MB'),
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

        const content: Record<string, unknown>[] = [{ type: 'text', text: JSON.stringify(result, null, 2) }]

        for (const file of result.files) {
          const name = file.path.split('/').pop() ?? file.path
          content.push({ type: 'resource_link', uri: `file://${file.path}`, name })
          if (!args.return_file) continue
          if (file.bytes > 4_000_000) {
            content.push({ type: 'text', text: `${name} is ${(file.bytes / 1e6).toFixed(1)}MB, too large to return inline. Use a lower resolution or jpeg.` })
            continue
          }
          const { readFile } = await import('node:fs/promises')
          const data = (await readFile(file.path)).toString('base64')
          const mime = args.format === 'pdf'
            ? 'application/pdf'
            : args.format === 'jpeg' ? 'image/jpeg' : args.format === 'tiff' ? 'image/tiff' : 'image/png'
          content.push(args.format === 'pdf' || args.format === 'tiff'
            ? { type: 'resource', resource: { uri: `file://${file.path}`, mimeType: mime, blob: data } }
            : { type: 'image', data, mimeType: mime })
        }

        return { content } as never
      } catch (err) {
        return fail(err)
      }
    },
  )

  return server
}

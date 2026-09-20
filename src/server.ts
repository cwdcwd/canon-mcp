#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { config, deviceOptions, listDevices, scan } from './scanner.ts'

const server = new McpServer({ name: 'scanner', version: '0.1.0' })

const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
})

server.registerTool(
  'list_scanners',
  {
    title: 'List scanners',
    description: 'List SANE scanners reachable from this machine',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    try {
      const devices = await listDevices()
      return { content: [{ type: 'text', text: JSON.stringify(devices, null, 2) }] }
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
    description: `Scan from the flatbed or document feeder and save to disk. Files go to ${config.outputDir} unless output_dir is given. A 300 dpi color page takes about a minute over Wi-Fi.`,
    inputSchema: {
      resolution: z.union([z.literal(75), z.literal(150), z.literal(300), z.literal(600)]).default(300),
      mode: z.enum(['Color', 'Gray', 'Lineart']).default('Color'),
      source: z.enum(['Flatbed', 'ADF']).default('Flatbed').describe('ADF scans every page in the feeder'),
      format: z.enum(['png', 'jpeg', 'tiff', 'pdf']).default('pdf'),
      name: z.string().regex(/^[\w .-]+$/).optional().describe('Base filename without extension'),
      output_dir: z.string().optional(),
      device: z.string().optional(),
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
      return {
        content: [
          { type: 'text', text: JSON.stringify(result, null, 2) },
          ...result.files.map(f => ({
            type: 'resource_link' as const,
            uri: `file://${f.path}`,
            name: f.path.split('/').pop() ?? f.path,
          })),
        ],
      }
    } catch (err) {
      return fail(err)
    }
  },
)

await server.connect(new StdioServerTransport())

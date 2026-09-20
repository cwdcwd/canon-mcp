#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { deviceOptions, listDevices, scan, ScanError } from './scanner.ts'
import type { Format, Mode, Resolution, Source } from './scanner.ts'

const usage = `usage:
  scan [options]          scan a page
  scan list               list scanners
  scan options            show device options

options:
  -r, --resolution  75|150|300|600   (300)
  -m, --mode        color|gray|lineart (color)
  -s, --source      flatbed|adf      (flatbed)
  -f, --format      png|jpeg|tiff|pdf (png)
  -o, --out         output directory (~/Desktop/Scans, or $SCAN_OUTPUT_DIR)
  -n, --name        base filename
  -d, --device      SANE device (auto, or $SCAN_DEVICE)
      --open        reveal result in Finder`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    resolution: { type: 'string', short: 'r' },
    mode: { type: 'string', short: 'm' },
    source: { type: 'string', short: 's' },
    format: { type: 'string', short: 'f' },
    out: { type: 'string', short: 'o' },
    name: { type: 'string', short: 'n' },
    device: { type: 'string', short: 'd' },
    open: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
})

const oneOf = <T extends string>(val: string | undefined, allowed: readonly T[], flag: string) => {
  if (val === undefined) return undefined
  const hit = allowed.find(a => a.toLowerCase() === val.toLowerCase())
  if (!hit) throw new ScanError(`--${flag} must be one of ${allowed.join(', ')}`)
  return hit
}

const main = async () => {
  if (values.help) return console.log(usage)
  const cmd = positionals[0]

  if (cmd === 'list') {
    for (const d of await listDevices()) console.log(`${d.name}\t${d.vendor} ${d.model} (${d.type})`)
    return
  }
  if (cmd === 'options') return console.log(await deviceOptions(values.device))
  if (cmd) throw new ScanError(`unknown command: ${cmd}\n\n${usage}`)

  const res = oneOf(values.resolution, ['75', '150', '300', '600'] as const, 'resolution')
  const result = await scan({
    device: values.device,
    resolution: res ? (Number(res) as Resolution) : undefined,
    mode: oneOf<Mode>(values.mode, ['Color', 'Gray', 'Lineart'], 'mode'),
    source: oneOf<Source>(values.source, ['Flatbed', 'ADF'], 'source'),
    format: oneOf<Format>(values.format, ['png', 'jpeg', 'tiff', 'pdf'], 'format'),
    outputDir: values.out,
    name: values.name,
    onProgress: pct => process.stderr.write(`\rscanning… ${pct}%`),
  })
  process.stderr.write('\n')

  for (const f of result.files) console.log(f.path)
  console.error(`${result.files.length} file(s) in ${(result.durationMs / 1000).toFixed(1)}s`)

  if (values.open) {
    const { spawn } = await import('node:child_process')
    spawn('open', ['-R', result.files[0].path], { stdio: 'ignore', detached: true }).unref()
  }
}

main().catch(err => {
  process.stderr.write('\n')
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})

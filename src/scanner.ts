import { spawn } from 'node:child_process'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export type Resolution = 75 | 150 | 300 | 600
export type Mode = 'Color' | 'Gray' | 'Lineart'
export type Source = 'Flatbed' | 'ADF'
export type Format = 'png' | 'jpeg' | 'tiff' | 'pdf'

export type ScanOptions = {
  device?: string
  resolution?: Resolution
  mode?: Mode
  source?: Source
  format?: Format
  outputDir?: string
  name?: string
  timeoutMs?: number
  onProgress?: (pct: number) => void
}

export type ScanResult = {
  device: string
  files: { path: string, bytes: number }[]
  durationMs: number
}

export type Device = { name: string, vendor: string, model: string, type: string }

const EXT: Record<Format, string> = { png: 'png', jpeg: 'jpg', tiff: 'tif', pdf: 'pdf' }

export const config = {
  bin: process.env.SCANIMAGE_BIN ?? '/opt/homebrew/bin/scanimage',
  device: process.env.SCAN_DEVICE,
  outputDir: process.env.SCAN_OUTPUT_DIR ?? join(homedir(), 'Desktop', 'Scans'),
}

export class ScanError extends Error {
  stderr: string
  constructor(message: string, stderr = '') {
    super(message)
    this.stderr = stderr
  }
}

type RunResult = { code: number | null, signal: NodeJS.Signals | null, stdout: string, stderr: string }

const run = (args: string[], opts: { timeoutMs?: number, onStderr?: (chunk: string) => void } = {}) =>
  new Promise<RunResult>((res, rej) => {
    const child = spawn(config.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => {
      const s = String(d)
      stderr += s
      opts.onStderr?.(s)
    })
    const timer = opts.timeoutMs
      ? setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs)
      : undefined
    child.on('error', err => {
      clearTimeout(timer)
      rej(new ScanError(`Failed to launch ${config.bin}: ${err.message}. Is sane-backends installed?`))
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      res({ code, signal, stdout, stderr })
    })
  })

const explain = (r: RunResult, what: string) => {
  if (r.signal === 'SIGPIPE' || r.code === 141) {
    return `${what} was killed by SIGPIPE while talking to the scanner. macOS is blocking UDP to the LAN for the app that launched this process (Local Network privacy). Run it from Terminal.app or an app with working Local Network access.`
  }
  if (r.signal === 'SIGTERM') return `${what} timed out`
  const last = r.stderr.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('Progress:')).pop()
  return `${what} failed (exit ${r.code}): ${last ?? 'no output'}`
}

export const listDevices = async (): Promise<Device[]> => {
  const r = await run(['-f', '%d\t%v\t%m\t%t%n'], { timeoutMs: 30_000 })
  if (r.code !== 0) throw new ScanError(explain(r, 'Device discovery'), r.stderr)
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [name, vendor, model, type] = line.split('\t')
      return { name, vendor, model, type }
    })
}

export const resolveDevice = async (device?: string) => {
  const explicit = device ?? config.device
  if (explicit) return explicit
  const devices = await listDevices()
  if (!devices.length) throw new ScanError('No scanners found. Set SCAN_DEVICE or add bjnp://<ip> to pixma.conf.')
  return devices[0].name
}

export const deviceOptions = async (device?: string) => {
  const dev = await resolveDevice(device)
  const r = await run(['-d', dev, '-A'], { timeoutMs: 30_000 })
  if (r.code !== 0) throw new ScanError(explain(r, 'Reading options'), r.stderr)
  return r.stdout.trim()
}

const timestamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)

export const scan = async (opts: ScanOptions = {}): Promise<ScanResult> => {
  const device = await resolveDevice(opts.device)
  const format = opts.format ?? 'png'
  const source = opts.source ?? 'Flatbed'
  const outputDir = resolve(opts.outputDir ?? config.outputDir)
  const base = opts.name ?? `scan-${timestamp()}`
  await mkdir(outputDir, { recursive: true })

  // --source must come before mode/resolution, it resets them
  const args = [
    '-d', device,
    '--source', source === 'ADF' ? 'Automatic Document Feeder' : 'Flatbed',
    '--mode', opts.mode ?? 'Color',
    '--resolution', String(opts.resolution ?? 300),
    `--format=${format}`,
    '-p',
  ]

  const ext = EXT[format]
  const single = join(outputDir, `${base}.${ext}`)
  if (source === 'ADF') args.push(`--batch=${join(outputDir, `${base}-%03d.${ext}`)}`)
  else args.push('-o', single)

  const started = Date.now()
  let lastPct = -1
  const r = await run(args, {
    timeoutMs: opts.timeoutMs ?? 5 * 60_000,
    onStderr: chunk => {
      if (!opts.onProgress) return
      for (const m of chunk.matchAll(/Progress:\s*([\d.]+)%/g)) {
        const pct = Math.floor(Number(m[1]))
        if (pct !== lastPct) opts.onProgress((lastPct = pct))
      }
    },
  })

  const paths = source === 'ADF'
    ? (await readdir(outputDir))
      .filter(f => f.startsWith(`${base}-`) && f.endsWith(`.${ext}`))
      .sort()
      .map(f => join(outputDir, f))
    : [single]

  const files = (await Promise.all(paths.map(async path => {
    const s = await stat(path).catch(() => undefined)
    return s && s.size > 0 ? { path, bytes: s.size } : undefined
  }))).filter(f => f !== undefined)

  // ADF exits non-zero ("out of documents") once the feeder empties, that's fine if pages came through
  const ok = r.code === 0 || (source === 'ADF' && files.length > 0 && !r.signal)
  if (!ok || !files.length) throw new ScanError(explain(r, 'Scan'), r.stderr)

  return { device, files, durationMs: Date.now() - started }
}

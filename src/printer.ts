import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type PrintOptions = {
  copies?: number
  media?: string
  sides?: 'one-sided'
  colorMode?: 'color' | 'monochrome'
  quality?: 'draft' | 'normal' | 'high'
  fitToPage?: boolean
  pages?: string
  title?: string
}

export type PrintJob = { id: string, title?: string, user?: string, size?: string, submitted?: string }

export type PrinterStatus = {
  printer: string
  uri?: string
  state: string
  stateReasons?: string[]
  model?: string
  ink?: { name: string, level: number }[]
  queued: number
}

export const printConfig = {
  queue: process.env.PRINTER_QUEUE ?? 'MX490',
  uri: process.env.PRINTER_URI ?? (process.env.PRINTER_HOST ? `ipp://${process.env.PRINTER_HOST}/ipp/print` : undefined),
}

export class PrintError extends Error {}

type RunResult = { code: number | null, stdout: string, stderr: string }

const run = (bin: string, args: string[], timeoutMs = 30_000) =>
  new Promise<RunResult>((res, rej) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    child.on('error', err => {
      clearTimeout(timer)
      rej(new PrintError(`${bin} failed to start: ${err.message}. Is CUPS installed in this image?`))
    })
    child.on('close', code => {
      clearTimeout(timer)
      res({ code, stdout, stderr })
    })
  })

const need = (r: RunResult, what: string) => {
  if (r.code === 0) return r.stdout
  const detail = (r.stderr || r.stdout).trim().split('\n').pop()
  throw new PrintError(`${what} failed: ${detail ?? `exit ${r.code}`}`)
}

export const listPrinters = async () => {
  const r = await run('lpstat', ['-p'])
  if (r.code !== 0 && !r.stdout) return []
  return r.stdout
    .split('\n')
    .filter(l => l.startsWith('printer '))
    .map(l => {
      const [, name, ...rest] = l.split(' ')
      return { name, state: rest.join(' ').replace(/^is /, '') }
    })
}

/** IPP attributes straight from the printer: ink levels, state, model. */
const printerAttributes = async () => {
  if (!printConfig.uri) return undefined
  const test = join(tmpdir(), 'get-attrs.test')
  await writeFile(test, '{ OPERATION Get-Printer-Attributes\n  GROUP operation-attributes-tag\n  ATTR charset attributes-charset utf-8\n  ATTR language attributes-natural-language en\n  ATTR uri printer-uri $uri\n}\n')
  const r = await run('ipptool', ['-tv', printConfig.uri, test], 20_000)
  if (r.code !== 0) return undefined

  const value = (key: string) => r.stdout.match(new RegExp(`${key} \\([^)]*\\) = (.*)`))?.[1]?.trim()
  const names = value('marker-names')?.split(',').map(s => s.trim())
  const levels = value('marker-levels')?.split(',').map(s => Number(s.trim()))

  return {
    state: value('printer-state') ?? 'unknown',
    stateReasons: value('printer-state-reasons')?.split(',').map(s => s.trim()),
    model: value('printer-make-and-model'),
    ink: names && levels ? names.map((name, i) => ({ name, level: levels[i] ?? -1 })) : undefined,
  }
}

export const printerStatus = async (): Promise<PrinterStatus> => {
  const [printers, jobs, attrs] = await Promise.all([listPrinters(), listPrintJobs(), printerAttributes()])
  const queue = printers.find(p => p.name === printConfig.queue)
  return {
    printer: printConfig.queue,
    uri: printConfig.uri,
    state: attrs?.state ?? queue?.state ?? 'unknown',
    stateReasons: attrs?.stateReasons,
    model: attrs?.model,
    ink: attrs?.ink,
    queued: jobs.length,
  }
}

export const listPrintJobs = async (): Promise<PrintJob[]> => {
  const r = await run('lpstat', ['-o'])
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [id, user, size, ...when] = line.trim().split(/\s+/)
      return { id, user, size, submitted: when.join(' ') }
    })
}

export const cancelPrintJob = async (id: string) => {
  const r = await run('cancel', [id])
  if (r.code !== 0) throw new PrintError(`cancel failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`)
}

export const printFile = async (path: string, opts: PrintOptions = {}) => {
  const args = ['-d', printConfig.queue]
  if (opts.title) args.push('-t', opts.title)
  if (opts.copies && opts.copies > 1) args.push('-n', String(opts.copies))
  if (opts.pages) args.push('-P', opts.pages)
  const o = (v: string) => args.push('-o', v)
  if (opts.media) o(`media=${opts.media}`)
  o(`sides=${opts.sides ?? 'one-sided'}`)
  if (opts.colorMode) o(`print-color-mode=${opts.colorMode}`)
  if (opts.quality) o(`print-quality=${{ draft: '3', normal: '4', high: '5' }[opts.quality]}`)
  if (opts.fitToPage !== false) o('fit-to-page')
  args.push(path)

  const out = need(await run('lp', args, 60_000), 'lp')
  // "request id is MX490-7 (1 file(s))"
  const id = out.match(/request id is (\S+)/)?.[1]
  if (!id) throw new PrintError(`lp gave no job id: ${out.trim()}`)
  return { jobId: id, printer: printConfig.queue, file: path }
}

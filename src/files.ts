import { readdir, stat, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { config } from './scanner.ts'

export type ScanFile = { name: string, path: string, bytes: number, modified: string, mimeType: string }

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  pdf: 'application/pdf',
  pnm: 'image/x-portable-anymap',
}

export const mimeFor = (name: string) => MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'

export const isTextMime = (mime: string) => mime.startsWith('text/')

/** Reject anything that isn't a plain filename in the scan directory. */
export const resolveScan = (name: string) => {
  const safe = basename(name)
  if (!safe || safe.startsWith('.') || safe !== name) throw new Error(`invalid file name: ${name}`)
  return join(config.outputDir, safe)
}

export const deleteScan = async (name: string) => {
  await unlink(resolveScan(name))
}

export const listScans = async (): Promise<ScanFile[]> => {
  const names = await readdir(config.outputDir).catch(() => [])
  const files = await Promise.all(names
    .filter(n => !n.startsWith('.'))
    .map(async name => {
      const path = join(config.outputDir, name)
      const s = await stat(path).catch(() => undefined)
      if (!s?.isFile()) return undefined
      return { name, path, bytes: s.size, modified: s.mtime.toISOString(), mimeType: mimeFor(name) }
    }))
  return files
    .filter(f => f !== undefined)
    .sort((a, b) => b.modified.localeCompare(a.modified))
}

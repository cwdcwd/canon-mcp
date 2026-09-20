import { randomUUID } from 'node:crypto'

export type JobStatus = 'running' | 'done' | 'error'

export type Job<T = unknown> = {
  id: string
  status: JobStatus
  progress: number
  startedAt: string
  finishedAt?: string
  result?: T
  error?: string
}

const MAX_JOBS = 50
const TTL_MS = 60 * 60_000

const jobs = new Map<string, Job>()

const prune = () => {
  const cutoff = Date.now() - TTL_MS
  for (const [id, job] of jobs) {
    const done = job.status !== 'running'
    if (done && new Date(job.finishedAt ?? job.startedAt).getTime() < cutoff) jobs.delete(id)
  }
  while (jobs.size > MAX_JOBS) {
    const oldest = [...jobs.values()]
      .filter(j => j.status !== 'running')
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0]
    if (!oldest) break
    jobs.delete(oldest.id)
  }
}

/** Run work in the background, tracked by id. The runner reports 0-100 progress. */
export const startJob = <T>(run: (onProgress: (pct: number) => void) => Promise<T>): Job<T> => {
  prune()
  const job: Job<T> = { id: randomUUID(), status: 'running', progress: 0, startedAt: new Date().toISOString() }
  jobs.set(job.id, job as Job)

  run(pct => { job.progress = pct })
    .then(result => {
      job.status = 'done'
      job.progress = 100
      job.result = result
    })
    .catch((err: unknown) => {
      job.status = 'error'
      job.error = err instanceof Error ? err.message : String(err)
    })
    .finally(() => { job.finishedAt = new Date().toISOString() })

  return job
}

export const getJob = (id: string) => jobs.get(id)

export const listJobs = () => [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt))

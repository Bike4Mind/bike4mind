import { z } from 'zod';
import { WAIT_BUDGET_SECONDS } from '../context';
import { envelope, fail, ok, withStatus } from '../results';
import { defineTool } from '../tool';
import { parseJob, type ParsedJob } from './registry';
import type { JobStatus } from './types';

const POLL_START_MS = 1000;
const POLL_MAX_MS = 5000;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const jobStatusSchema = z.object({
  job: z.string(),
  state: z.enum(['pending', 'done', 'failed', 'cancelled']),
  result: z.unknown().optional(),
  error: z.string().optional(),
});

export const waitForJob = defineTool({
  name: 'wait_for_job',
  title: 'Wait for jobs',
  description:
    "Waits up to max_wait_seconds for one or more jobs to finish and returns each one's state. Jobs still running " +
    'come back as pending: call again with the same ids to keep waiting. The wait is capped by the server.',
  toolset: 'jobs',
  scope: null,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    jobs: z.array(z.string().min(1).max(200)).min(1).max(10).describe('Job ids returned by other tools.'),
    max_wait_seconds: z.number().int().min(1).max(WAIT_BUDGET_SECONDS.stdio).default(20),
  },
  outputSchema: envelope(z.object({ jobs: z.array(jobStatusSchema) })),
  async handler({ jobs, max_wait_seconds }, ctx) {
    const parsed: { job: string; parsed: ParsedJob }[] = [];
    for (const job of jobs) {
      const p = parseJob(job);
      if (typeof p === 'string') return fail(p);
      parsed.push({ job, parsed: p });
    }

    const budgetMs = Math.min(max_wait_seconds, ctx.waitBudgetSeconds, WAIT_BUDGET_SECONDS[ctx.kind]) * 1000;
    const deadline = Date.now() + budgetMs;
    const statuses = new Map<string, JobStatus>(parsed.map(p => [p.job, { state: 'pending' }]));
    let delay = POLL_START_MS;

    for (;;) {
      await Promise.all(
        parsed
          .filter(p => statuses.get(p.job)?.state === 'pending')
          .map(async p => {
            try {
              statuses.set(p.job, await p.parsed.kind.poll(p.parsed.id, ctx));
            } catch (error) {
              statuses.set(p.job, { state: 'failed', error: error instanceof Error ? error.message : String(error) });
            }
          })
      );
      const left = deadline - Date.now();
      if (![...statuses.values()].some(s => s.state === 'pending') || left <= 0) break;
      await sleep(Math.min(delay, left));
      delay = Math.min(delay * 1.5, POLL_MAX_MS);
    }

    const list = parsed.map(p => ({ job: p.job, ...statuses.get(p.job)! }));
    const settled = list.every(j => j.state !== 'pending');
    return withStatus(settled ? 'done' : 'pending', { jobs: list });
  },
});

export const stopJob = defineTool({
  name: 'stop_job',
  title: 'Stop a job',
  description: 'Cancels a running job. For a confirmation, this withdraws it. Stopping a finished job is a no-op.',
  toolset: 'jobs',
  scope: null,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  inputSchema: { job: z.string().min(1).max(200).describe('Job id returned by another tool.') },
  outputSchema: envelope(z.object({ job: z.string(), state: z.literal('cancelled') })),
  async handler({ job }, ctx) {
    const parsed = parseJob(job);
    if (typeof parsed === 'string') return fail(parsed);
    await parsed.kind.stop(parsed.id, ctx);
    return ok({ job, state: 'cancelled' });
  },
});

export const jobTools = [waitForJob, stopJob];

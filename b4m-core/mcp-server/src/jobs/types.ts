import type { z } from 'zod';
import type { ToolContext } from '../context';

export type JobState = 'pending' | 'done' | 'failed' | 'cancelled';

export interface JobStatus {
  state: JobState;
  result?: unknown;
  error?: string;
}

/** One kind of long-running work. A job is the opaque string `<kind>:<id>`. */
export interface JobKind {
  kind: string;
  idSchema: z.ZodType<string>;
  poll(id: string, ctx: ToolContext): Promise<JobStatus>;
  /** Cancels the work. Must be idempotent: stopping a finished or missing job is not an error. */
  stop(id: string, ctx: ToolContext): Promise<void>;
}

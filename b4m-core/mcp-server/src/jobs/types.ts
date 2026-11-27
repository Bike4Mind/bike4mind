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
  /**
   * Reads the job's state. Return `failed` only for a definitive answer; throw for a transient one (transport error,
   * 429, 5xx) and the wait loop keeps the job pending. `signal` aborts at the wait deadline: forward it to the transport.
   */
  poll(id: string, ctx: ToolContext, signal: AbortSignal): Promise<JobStatus>;
  /** Cancels the work and returns whether anything was cancelled. Idempotent: a finished or missing job is not an error. */
  stop(id: string, ctx: ToolContext, signal: AbortSignal): Promise<boolean>;
}

import { objectIdSchema } from '../ids';
import type { JobKind, JobStatus } from './types';

// The pending-action API is not built yet; this reads the assumed `{ status }` body and treats anything else as pending.
const STATE: Record<string, JobStatus['state']> = {
  pending: 'pending',
  approved: 'done',
  declined: 'failed',
  expired: 'failed',
  withdrawn: 'cancelled',
};

// Retryable by definition: request timeout, too early, rate limited.
const TRANSIENT = new Set([408, 425, 429]);

export const confirmationJob: JobKind = {
  kind: 'confirmation',
  idSchema: objectIdSchema,

  async poll(id, ctx, signal) {
    const res = await ctx.transport.call('getMcpConfirmation', { params: { id }, signal });
    if (res.status === 404) return { state: 'failed', error: 'Confirmation not found or already expired.' };
    if (TRANSIENT.has(res.status) || res.status >= 500)
      throw new Error(`confirmation lookup returned HTTP ${res.status}`);
    if (res.status < 200 || res.status >= 300) {
      return { state: 'failed', error: `Confirmation lookup was refused with HTTP ${res.status}.` };
    }
    const body = (res.json ?? {}) as { status?: unknown };
    const state = typeof body.status === 'string' ? (STATE[body.status] ?? 'pending') : 'pending';
    return {
      state,
      ...(state === 'failed' ? { error: `Confirmation ${String(body.status)}.` } : {}),
      result: res.json,
    };
  },

  async stop(id, ctx, signal) {
    const res = await ctx.transport.call('withdrawMcpConfirmation', { params: { id }, signal });
    if (res.status === 404) return false;
    if (res.status < 200 || res.status >= 300)
      throw new Error(`withdrawing the confirmation returned HTTP ${res.status}`);
    return true;
  },
};

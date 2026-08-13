import { z } from 'zod';

/**
 * Provenance vocabulary for the convergence kill switch (#1676). Kept dependency-light (zod only)
 * so a background PRODUCER can stamp a message without pulling in the enforcement path's services
 * graph - the actual read/halt logic lives in `convergenceKillSwitch.ts`, which builds on this.
 *
 * `user` = a real-time user action (an upload, a manual reprocess) that must ALWAYS run.
 * `convergence` = background lake work (rescue sweeps, owner-triggered convergence waves) the kill
 * switch may halt. The chunk and vectorize handlers are SHARED between the two, so this flag is the
 * only thing that lets the switch stop background churn without stopping customer uploads.
 */
export const WORK_ORIGINS = ['user', 'convergence'] as const;
export type WorkOrigin = (typeof WORK_ORIGINS)[number];
export const WorkOriginSchema = z.enum(WORK_ORIGINS);

/** The provenance a background producer stamps so its work is haltable. */
export const CONVERGENCE_ORIGIN: WorkOrigin = 'convergence';

/**
 * Provenance fields shared by the chunk and vectorize SQS payloads. Spread into both so they can't
 * drift. `origin` fails soft to undefined (`.catch`) => treated as `user` => never halted: only work
 * EXPLICITLY tagged convergence is haltable, so a missing/malformed origin can't strand a user
 * upload. `lakeId` keys a per-lake pause (absent for a global sweep).
 */
export const provenancePayloadShape = {
  origin: WorkOriginSchema.optional().catch(undefined),
  lakeId: z.string().optional(),
};

/**
 * THE kill-switch decision. Pure, so the load-bearing invariant - user work is NEVER halted, only
 * convergence work is gated on the resolved pause flag - is testable across every (origin x paused)
 * shape without a DB. Keep this the single home of that rule.
 */
export function shouldHaltConvergence(origin: WorkOrigin, paused: boolean): boolean {
  if (origin !== 'convergence') return false;
  return paused;
}

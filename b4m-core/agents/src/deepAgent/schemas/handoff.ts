import { z } from 'zod';

/**
 * The Handoff is the fast-changing, per-wake document that captures *where
 * the agent left off* and *what it intends to do next*. Read on every wake;
 * written at the end of every wake cycle's reflect step.
 *
 * Lifted directly from `q-paper-neutron-scattering/reproduction/handoff.md`,
 * which evolved organically because the reproduction_charter.md became too
 * heavy to update every cycle. The split is load-bearing:
 *
 *   - Charter  = slow-changing identity + goal + groomed semantic memory
 *   - Handoff  = fast-changing "current state of work"
 *
 * Together they form the agent's persistent identity across the inevitable
 * discontinuities (Lambda cold starts, deploys, model swaps).
 */
export const HandoffSchema = z.object({
  agentId: z.string().min(1),
  /** Monotonic counter, bumped on every wake cycle. */
  wakeCount: z.number().int().nonnegative(),
  /** ISO-8601 of the most recent wake. */
  lastWakeAt: z.string().datetime(),
  /**
   * One-paragraph summary of what was done in the last wake cycle.
   * The reflect step writes this. Short enough to fit comfortably in any
   * subsequent orient prompt.
   */
  lastActionSummary: z.string().default(''),
  /**
   * What the agent intends to do on the next wake. Written by the reflect
   * step. The orient step uses it as a strong prior but is free to override
   * if drives or new observations dictate.
   */
  nextIntendedAction: z.string().default(''),
  /**
   * Hint from the agent about how soon it should wake again, in
   * milliseconds. The scheduler may honor or override based on drive state,
   * cost budget, and external triggers.
   *
   *   - Hot loop (active debugging): minutes
   *   - Normal research cadence: hours
   *   - Waiting on external process (training, build): much longer
   */
  nextWakeIntervalMs: z.number().int().positive().optional(),
  /**
   * Active blockers, in human-readable form. Mirrors the workflow blocker
   * system but local to the agent's working surface.
   */
  openBlockers: z.array(z.string()).default([]),
  /**
   * The id of the most recent episode record. Lets the next wake load the
   * tail of episodic memory without scanning.
   */
  lastEpisodeId: z.string().optional(),
  /** ISO-8601 of last update. */
  updatedAt: z.string().datetime(),
});

export type Handoff = {
  agentId: string;
  wakeCount: number;
  lastWakeAt: string;
  lastActionSummary: string;
  nextIntendedAction: string;
  nextWakeIntervalMs?: number;
  openBlockers: string[];
  lastEpisodeId?: string;
  updatedAt: string;
};

/**
 * Measure the on-disk size of a handoff when serialized as JSON.
 * Mirrors `measureCharterSizeBytes`; used for size-aware logging and tests.
 */
export function measureHandoffSizeBytes(handoff: Handoff): number {
  return Buffer.byteLength(JSON.stringify(handoff), 'utf8');
}

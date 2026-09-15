import { z } from 'zod';

/**
 * Drives are bounded scalars in [0, 1] that decay over time and are satisfied
 * by certain action classes. They give the agent a *direction* between
 * explicit prompts - the "Sims needs system" applied to autonomous agents.
 *
 * At policy time, the current drive vector is summarized in natural language
 * and injected into the orient prompt (e.g., "you are feeling curious,
 * somewhat bored, slightly anxious about progress").
 *
 * Each named drive captures one motivational axis:
 *
 * - `curiosity`: satisfied by encountering novelty/surprise; decays when
 *   observations are repetitive.
 * - `progress`: satisfied by measurable goal-state change; decays when
 *   wake cycles produce no advancement.
 * - `social`: satisfied by human interaction; decays when the agent runs
 *   without external input.
 * - `novelty`: satisfied by producing a falsifiable, original hypothesis
 *   (distinct from curiosity, which is satisfied by intake). Decays as the
 *   corpus of read material grows without ideation.
 * - `caution`: rises with budget burn or repeated failure; biases the
 *   policy step toward cheaper / lower-tier actions.
 * - `aesthetic`: satisfied by polish/refinement actions. Tunable for
 *   game-design-style work where craft matters.
 */
export const DriveVectorSchema = z.object({
  curiosity: z.number().min(0).max(1),
  progress: z.number().min(0).max(1),
  social: z.number().min(0).max(1),
  novelty: z.number().min(0).max(1),
  caution: z.number().min(0).max(1),
  aesthetic: z.number().min(0).max(1),
});

/**
 * Explicit shape rather than `z.infer<typeof DriveVectorSchema>` for stable
 * inference across zod versions (see DAG Phase 4a note in dag/schemas.ts).
 */
export type DriveVector = {
  curiosity: number;
  progress: number;
  social: number;
  novelty: number;
  caution: number;
  aesthetic: number;
};

export const DRIVE_KEYS = [
  'curiosity',
  'progress',
  'social',
  'novelty',
  'caution',
  'aesthetic',
] as const satisfies ReadonlyArray<keyof DriveVector>;

export type DriveKey = (typeof DRIVE_KEYS)[number];

/**
 * A neutral starting drive vector. Specific agent classes (paper-repro,
 * game-dev, web-research) will override these defaults via toolbelt profiles.
 */
export const DEFAULT_DRIVES: DriveVector = {
  curiosity: 0.5,
  progress: 0.5,
  social: 0.5,
  novelty: 0.5,
  caution: 0.5,
  aesthetic: 0.5,
};

/**
 * Per-drive exponential decay half-lives in milliseconds.
 *
 * Half-life = how long until a drive at 1.0 (fully satisfied) decays
 * halfway back toward 0. Longer half-life = drive remains satisfied
 * longer between cycles.
 *
 * Rationale per drive:
 *   - curiosity: decays moderately fast - novelty fades quickly
 *   - progress: decays slowly - sense of progress is sticky
 *   - social: decays moderately - humans drift in and out
 *   - novelty: decays slowly - original ideation is a long-tail satisfier
 *   - caution: decays moderately fast - fear fades when nothing breaks
 *   - aesthetic: decays slowly - craft satisfaction is durable
 *
 * Tunable per agent class. These are starting points.
 */
export const DEFAULT_HALF_LIVES_MS: Record<DriveKey, number> = {
  curiosity: 1000 * 60 * 60 * 2, // 2h
  progress: 1000 * 60 * 60 * 12, // 12h
  social: 1000 * 60 * 60 * 4, // 4h
  novelty: 1000 * 60 * 60 * 24, // 24h
  caution: 1000 * 60 * 60 * 1, // 1h
  aesthetic: 1000 * 60 * 60 * 8, // 8h
};

/**
 * Clamp a value into [0, 1].
 */
function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * Apply exponential decay to every drive based on elapsed time.
 *
 * For each drive d with half-life h:  d' = d * 0.5^(elapsedMs / h)
 *
 * Pure function - does not mutate input. Negative elapsed times are
 * treated as zero (no time-travel decay).
 */
export function decayDrives(
  drives: DriveVector,
  elapsedMs: number,
  halfLives: Record<DriveKey, number> = DEFAULT_HALF_LIVES_MS
): DriveVector {
  const dt = Math.max(0, elapsedMs);
  const result = { ...drives } as DriveVector;
  for (const key of DRIVE_KEYS) {
    const halfLife = halfLives[key];
    const factor = halfLife > 0 ? Math.pow(0.5, dt / halfLife) : 1;
    result[key] = clamp01(drives[key] * factor);
  }
  return result;
}

/**
 * Apply a bounded additive delta to a drive vector.
 *
 * Each entry in `delta` is added to the corresponding drive and clamped
 * back into [0, 1]. Unspecified drives are unchanged. Pure function.
 */
export function applyDriveDelta(drives: DriveVector, delta: Partial<Record<DriveKey, number>>): DriveVector {
  const result = { ...drives } as DriveVector;
  for (const key of DRIVE_KEYS) {
    const d = delta[key];
    if (typeof d === 'number' && Number.isFinite(d)) {
      result[key] = clamp01(drives[key] + d);
    }
  }
  return result;
}

/**
 * Map a drive value in [0, 1] to a natural-language intensity band.
 * Used by `summarizeDrives` to produce prompt-friendly text.
 */
function intensityBand(value: number): string {
  if (value < 0.15) return 'barely';
  if (value < 0.35) return 'slightly';
  if (value < 0.65) return 'moderately';
  if (value < 0.85) return 'strongly';
  return 'intensely';
}

/**
 * Produce a one-line natural-language summary of the drive vector,
 * suitable for injection into the orient prompt.
 *
 * Example output:
 *   "moderately curious, strongly motivated by progress, slightly social,
 *    moderately drawn to novelty, barely cautious, moderately aesthetic"
 */
export function summarizeDrives(drives: DriveVector): string {
  const labels: Record<DriveKey, string> = {
    curiosity: 'curious',
    progress: 'motivated by progress',
    social: 'social',
    novelty: 'drawn to novelty',
    caution: 'cautious',
    aesthetic: 'aesthetic',
  };
  return DRIVE_KEYS.map(k => `${intensityBand(drives[k])} ${labels[k]}`).join(', ');
}

/**
 * The kind-agnostic ordering and polling rules shared by the video and music job caches. Typed structurally so each
 * kind's wire shape (VideoGeneration, MusicGeneration) fits without a common base type.
 */
import { TERMINAL_GENERATION_JOB_STATES, type GenerationJobState } from '@bike4mind/common';

export type PollableGenerationJob = {
  state: GenerationJobState;
  updated_at: string;
  output: { availability: 'ready' | 'pending_scan' | 'unavailable'; expires_at: string | null } | null;
};

// Each job route has its own per-user bucket (as low as 10/min). At 4/min per job, three or more polling cards can draw 429s; those are not retried and the next tick tries again.
export const SOCKET_DOWN_POLL_MS = 15_000;
// A scan normally clears in well under a minute; one that stalls backs off with the job's age up to the cap, so a few
// stuck cards cannot drain that bucket.
export const PENDING_SCAN_POLL_MS = 30_000;
export const PENDING_SCAN_MAX_POLL_MS = 5 * 60_000;
// The output normally lands seconds after 'succeeded'; past this the card stops asking and stays on "Finishing".
export const AWAITING_OUTPUT_MAX_POLL_AGE_MS = 10 * 60_000;
// Signed URLs live 15 minutes (OUTPUT_URL_TTL_SECONDS on the server). The gallery list re-signs a whole page
// first (longer lead) so a page of cards sharing one expiry does not fire one request each: every job route is
// per-user rate-limited, as low as 10/min.
export const DETAIL_URL_REFRESH_LEAD_MS = 60_000;
export const LIST_URL_REFRESH_LEAD_MS = 120_000;
// Lower bound on every refresh delay. A fixed client-clock skew would otherwise yield the same short delay after each
// re-sign, a repeating loop against the 10/min per-user rate limit.
export const URL_REFRESH_FLOOR_MS = 60_000;

export const msUntil = (expiresAt: string, leadMs: number, now: number): number =>
  Math.max(Date.parse(expiresAt) - leadMs - now, URL_REFRESH_FLOOR_MS);

export const isTerminalGenerationState = (state: GenerationJobState): boolean =>
  TERMINAL_GENERATION_JOB_STATES.includes(state);

// The websocket frame writes 'succeeded' before the output exists; the job is not done until it arrives.
export const isAwaitingGenerationOutput = (job: Pick<PollableGenerationJob, 'state' | 'output'>): boolean =>
  job.state === 'succeeded' && !job.output;

// A live job only ever moves forward through these. Frames and patched rows carry no newer timestamp, so the rank is
// what tells a late 'running' apart from a real one.
const LIVE_STATE_RANK: Partial<Record<GenerationJobState, number>> = { pending: 0, running: 1, storing: 2 };

export const movesLiveStateBackwards = (from: GenerationJobState, to: GenerationJobState): boolean => {
  const fromRank = LIVE_STATE_RANK[from];
  const toRank = LIVE_STATE_RANK[to];
  return fromRank !== undefined && toRank !== undefined && toRank < fromRank;
};

// A terminal job is final, and a snapshot read earlier (a list request that was in flight while a detail
// refetch landed) must not replace a later one.
export const shouldReplaceGenerationJob = <T extends Pick<PollableGenerationJob, 'state' | 'updated_at'>>(
  existing: T | undefined,
  incoming: T
): boolean => {
  if (!existing) return true;
  if (isTerminalGenerationState(existing.state) && !isTerminalGenerationState(incoming.state)) return false;
  const incomingAt = Date.parse(incoming.updated_at);
  const existingAt = Date.parse(existing.updated_at);
  // A websocket patch keeps the cached updated_at, so a list row read before the frame ties with it.
  if (incomingAt === existingAt && movesLiveStateBackwards(existing.state, incoming.state)) return false;
  return incomingAt >= existingAt;
};

/** The fallback poll for one job; live updates normally arrive over the websocket (GenerationUpdatesListener). */
export function generationJobPollInterval(
  job: PollableGenerationJob | undefined,
  socketOpen: boolean,
  now: number
): number | false {
  if (!job) return false;
  // Polled even with the socket open: no further frame will arrive, and the listener's one refetch may have been
  // rate-limited or landed before the output was written.
  if (isAwaitingGenerationOutput(job)) {
    return now - Date.parse(job.updated_at) < AWAITING_OUTPUT_MAX_POLL_AGE_MS ? SOCKET_DOWN_POLL_MS : false;
  }
  if (!isTerminalGenerationState(job.state)) return socketOpen ? false : SOCKET_DOWN_POLL_MS;
  if (job.state !== 'succeeded' || !job.output) return false;
  if (job.output.availability === 'pending_scan') {
    const age = now - Date.parse(job.updated_at);
    return Math.min(Math.max(age, PENDING_SCAN_POLL_MS), PENDING_SCAN_MAX_POLL_MS);
  }
  if (job.output.availability === 'ready' && job.output.expires_at) {
    return msUntil(job.output.expires_at, DETAIL_URL_REFRESH_LEAD_MS, now);
  }
  return false;
}

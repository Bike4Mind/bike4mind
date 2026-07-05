import {
  applyDriveDelta,
  decayDrives,
  DRIVE_KEYS,
  isCharterOverBudget,
  type Charter,
  type DriveKey,
  type Episode,
  type Handoff,
} from '../schemas';
import type { DeepAgentStore, ReflectResult, WakeOutcome, WakeSteps } from './types';

const DEFAULT_RECENT_LIMIT = 10;

/**
 * Hard ceiling on how far any single drive can move in one wake. The reflect
 * step proposes a post-wake vector; the orchestrator clamps the implied delta
 * to this bound before applying it - gradual motivation, no LLM-authored jumps.
 */
export const MAX_DRIVE_DELTA_PER_WAKE = 0.25;

/** Minimal structured logger surface - satisfied by @bike4mind/observability Logger. */
export interface WakeLogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
}

export interface WakeDeps {
  store: DeepAgentStore;
  steps: WakeSteps;
  /** Generates a stable Episode id (ULID/UUID in production; a counter in tests). */
  newEpisodeId: () => string;
  /** Wall clock in ms. Injected for deterministic tests. Defaults to Date.now. */
  now?: () => number;
  /** How many recent episodes to load into the orient context. */
  recentEpisodeLimit?: number;
  /** Optional logger - when present, each wake step is logged for live visibility. */
  logger?: WakeLogger;
}

/**
 * Run one wake cycle for an agent: orient -> act -> reflect -> persist episode ->
 * apply charter mutations -> groom-if-over-budget -> write handoff.
 *
 * Pure orchestration: all I/O goes through the injected `store`, all cognition
 * through the injected `steps`. Drives are time-decayed before the policy step
 * (the "Sims needs" pressure that gives the agent direction between prompts).
 */
export async function runWakeCycle(agentId: string, deps: WakeDeps): Promise<WakeOutcome> {
  const now = deps.now ?? Date.now;
  const nowMs = now();
  const nowIso = new Date(nowMs).toISOString();
  const recentLimit = deps.recentEpisodeLimit ?? DEFAULT_RECENT_LIMIT;

  const charter = await deps.store.loadCharter(agentId);
  if (!charter) {
    throw new Error(`runWakeCycle: no charter found for agent ${agentId}`);
  }
  const handoff = await deps.store.loadHandoff(agentId);
  const recentEpisodes = await deps.store.recentEpisodes(agentId, recentLimit);

  // Decay drives by the time elapsed since the last wake. First wake (no
  // handoff) sees no decay.
  const elapsedMs = handoff ? Math.max(0, nowMs - Date.parse(handoff.lastWakeAt)) : 0;
  const drives = decayDrives(charter.drives, elapsedMs);

  const log = deps.logger;
  log?.info('[deepAgent.wake] orienting', {
    agentId,
    wake: (handoff?.wakeCount ?? 0) + 1,
    tier: charter.currentTier,
    drives,
  });

  // Cognitive steps.
  const policy = await deps.steps.orient({ charter, handoff, recentEpisodes, drives });
  log?.info('[deepAgent.wake] policy', { actionKind: policy.actionKind, rationale: policy.rationale.slice(0, 200) });

  const act = await deps.steps.act({ charter, policy, drives });

  const reflect = await deps.steps.reflect({ charter, policy, act, drives, nowIso });
  log?.info('[deepAgent.wake] reflected', {
    summary: reflect.summary.slice(0, 200),
    scopeLocks: reflect.scopeLocks.length,
    addedMemory: reflect.addedSemanticMemory.length,
    nextIntendedAction: reflect.nextIntendedAction.slice(0, 160),
  });

  // Drives are deterministic: the LLM PROPOSES a post-wake vector, but the
  // math owns it - per-drive delta is clamped to ±MAX_DRIVE_DELTA_PER_WAKE and
  // applied via the bounded applyDriveDelta. The model never authors numbers
  // directly into state (anti-hallucination invariant).
  const driveDeltas: Partial<Record<DriveKey, number>> = {};
  for (const key of DRIVE_KEYS) {
    const proposed = reflect.drivesAfter[key] - drives[key];
    driveDeltas[key] = Math.max(-MAX_DRIVE_DELTA_PER_WAKE, Math.min(MAX_DRIVE_DELTA_PER_WAKE, proposed));
  }
  const drivesAfter = applyDriveDelta(drives, driveDeltas);

  // Record the wake as an immutable Episode. evidenceTier is the tier the agent
  // is currently operating at (reviewer routing keys off this downstream).
  // Note: a duplicate concurrent wake (SQS redelivery) may append its episode
  // before failing the versioned charter save - episodes are an append-only
  // log, so a stray duplicate is visible-but-harmless, never corrupting.
  const episodeId = deps.newEpisodeId();
  const episode: Episode = {
    id: episodeId,
    agentId,
    wakeAt: nowIso,
    drivesBefore: drives,
    policyDecision: policy,
    actionsTaken: act.actionsTaken,
    observations: act.observations,
    reflection: reflect.reflection,
    charterDiff: reflect.charterDiff,
    drivesAfter,
    scopeLocks: reflect.scopeLocks,
    evidenceTier: charter.currentTier,
    tokensSpent: act.tokensSpent,
    costUsd: act.costUsd,
  };
  const savedEpisode = await deps.store.appendEpisode(episode);

  // Apply the reflect step's mutations, then groom if the result is over budget.
  // Exactly one version bump per wake, regardless of grooming.
  let nextCharter = applyCharterMutations(charter, reflect, episodeId, nowIso);
  let groomed = false;
  if (isCharterOverBudget(nextCharter)) {
    log?.info('[deepAgent.wake] grooming (charter over budget)', { agentId });
    nextCharter = await deps.steps.groom({ charter: nextCharter, recentEpisodes, nowIso });
    groomed = true;
  }
  nextCharter = {
    ...nextCharter,
    drives: drivesAfter,
    version: charter.version + 1,
    updatedAt: nowIso,
    ...(groomed ? { groomedAt: nowIso } : {}),
  };
  const savedCharter = await deps.store.saveCharter(nextCharter);

  // The fast-changing handoff: where we left off + what's next.
  const nextHandoff: Handoff = {
    agentId,
    wakeCount: (handoff?.wakeCount ?? 0) + 1,
    lastWakeAt: nowIso,
    lastActionSummary: reflect.summary,
    nextIntendedAction: reflect.nextIntendedAction,
    ...(reflect.nextWakeIntervalMs !== undefined ? { nextWakeIntervalMs: reflect.nextWakeIntervalMs } : {}),
    openBlockers: reflect.openBlockers,
    lastEpisodeId: savedEpisode.id,
    updatedAt: nowIso,
  };
  const savedHandoff = await deps.store.saveHandoff(nextHandoff);

  return { episode: savedEpisode, charter: savedCharter, handoff: savedHandoff, groomed };
}

/**
 * Apply the reflect step's semantic-memory and subgoal mutations to a charter.
 * Does not touch version/timestamps - the caller owns those. Pure.
 *
 * Every added memory entry is stamped with the episode that produced it
 * (provenance - the audit trail that makes adversarial review tractable) and
 * reaffirmed at the wake timestamp.
 */
function applyCharterMutations(charter: Charter, reflect: ReflectResult, episodeId: string, nowIso: string): Charter {
  const removed = new Set(reflect.removedSemanticMemoryIds);
  // Upsert semantics keyed by id: added entries come from model output, so a
  // duplicate id (colliding with existing memory or within the batch) REPLACES
  // rather than duplicating - ids stay unique, removals stay unambiguous.
  const memoryById = new Map(charter.semanticMemory.filter(m => !removed.has(m.id)).map(m => [m.id, m]));
  for (const m of reflect.addedSemanticMemory) {
    memoryById.set(m.id, {
      ...m,
      sourceEpisodeIds: m.sourceEpisodeIds.includes(episodeId)
        ? m.sourceEpisodeIds
        : [...m.sourceEpisodeIds, episodeId],
      lastAffirmedAt: nowIso,
    });
  }
  const semanticMemory = [...memoryById.values()];

  const subgoalsById = new Map(charter.subgoals.map(s => [s.id, s]));
  for (const subgoal of reflect.subgoalUpdates) {
    subgoalsById.set(subgoal.id, subgoal);
  }

  return {
    ...charter,
    semanticMemory,
    subgoals: [...subgoalsById.values()],
    blockers: reflect.openBlockers,
  };
}

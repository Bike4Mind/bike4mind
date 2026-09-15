import { IDeepAgentCharter, ICharterIdentity, ICharterGoal, ISemanticMemoryEntry } from './DeepAgentCharterModel';
import { IDeepAgentHandoff } from './DeepAgentHandoffModel';
import { IDeepAgentEpisode } from './DeepAgentEpisodeModel';

/**
 * Persistence seam: Mongo docs <-> serialized domain DTOs.
 *
 * The Mongo models carry timestamps as `Date` (and the episode's stable id as
 * `episodeId`, to avoid colliding with the Mongo `id` virtual). The deep-agent
 * domain - the Zod schemas in `@bike4mind/agents/src/deepAgent/schemas/` - carry
 * timestamps as ISO strings and call the episode id `id`.
 *
 * These functions are the only place that Date<->string and episodeId<->id
 * conversion happens. The `Serialized*` types are structurally the agents Zod
 * output types; the runtime validates a `Serialized*` through the matching Zod
 * schema (e.g. `CharterSchema.parse(serializeCharter(doc))`) - that parse is
 * the point where any drift between the two layers surfaces.
 *
 * The database package stays free of any dependency on `@bike4mind/agents`.
 */

/** Recursively replace `Date` with `string` (ISO-8601), preserving structure. */
type Jsonify<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? Jsonify<U>[]
    : T extends object
      ? { [K in keyof T]: Jsonify<T[K]> }
      : T;

// ── Serialized DTO shapes (string timestamps; match the agents Zod types) ──

/** Mirrors `Charter` in `@bike4mind/agents`. Drops Mongo-only `id`/`createdAt`. */
export type SerializedCharter = Omit<Jsonify<IDeepAgentCharter>, 'id' | 'createdAt'>;

/**
 * Mirrors `Handoff` in `@bike4mind/agents`. Drops Mongo-only `id`/`createdAt`
 * and the derived `nextWakeAt` scheduling field (recomputed on write).
 */
export type SerializedHandoff = Omit<Jsonify<IDeepAgentHandoff>, 'id' | 'createdAt' | 'nextWakeAt'>;

/**
 * Mirrors `Episode` in `@bike4mind/agents`. Drops Mongo-only fields and renames
 * the stable id from `episodeId` back to `id`.
 */
export type SerializedEpisode = Omit<Jsonify<IDeepAgentEpisode>, 'id' | 'episodeId' | 'createdAt' | 'updatedAt'> & {
  id: string;
};

/** Doc fields Mongoose owns; never written by a mapper's deserialize output. */
type ManagedDocFields = 'id' | 'createdAt' | 'updatedAt';

const iso = (d: Date): string => d.toISOString();

// ── Charter ────────────────────────────────────────────────────────

export function serializeCharter(doc: IDeepAgentCharter): SerializedCharter {
  return {
    identity: serializeIdentity(doc.identity),
    goal: serializeGoal(doc.goal),
    drives: doc.drives,
    subgoals: doc.subgoals,
    semanticMemory: doc.semanticMemory.map(serializeMemory),
    currentTier: doc.currentTier,
    openQuestions: doc.openQuestions,
    blockers: doc.blockers,
    sizeBudgetBytes: doc.sizeBudgetBytes,
    version: doc.version,
    ...(doc.sessionId ? { sessionId: doc.sessionId } : {}),
    ...(doc.groomedAt ? { groomedAt: iso(doc.groomedAt) } : {}),
    updatedAt: iso(doc.updatedAt),
  };
}

/** Convert a serialized charter into the doc fields for a create/upsert write. */
export function deserializeCharter(charter: SerializedCharter): Omit<IDeepAgentCharter, ManagedDocFields> {
  return {
    identity: { ...charter.identity, instantiatedAt: new Date(charter.identity.instantiatedAt) },
    goal: {
      description: charter.goal.description,
      successCriteria: charter.goal.successCriteria,
      deadlineKind: charter.goal.deadlineKind,
      ...(charter.goal.deadlineAt ? { deadlineAt: new Date(charter.goal.deadlineAt) } : {}),
    },
    drives: charter.drives,
    subgoals: charter.subgoals,
    semanticMemory: charter.semanticMemory.map(m => ({
      ...m,
      lastAffirmedAt: new Date(m.lastAffirmedAt),
    })),
    currentTier: charter.currentTier,
    openQuestions: charter.openQuestions,
    blockers: charter.blockers,
    sizeBudgetBytes: charter.sizeBudgetBytes,
    version: charter.version,
    ...(charter.sessionId ? { sessionId: charter.sessionId } : {}),
    ...(charter.groomedAt ? { groomedAt: new Date(charter.groomedAt) } : {}),
  };
}

function serializeIdentity(identity: ICharterIdentity): SerializedCharter['identity'] {
  return { ...identity, instantiatedAt: iso(identity.instantiatedAt) };
}

function serializeGoal(goal: ICharterGoal): SerializedCharter['goal'] {
  return {
    description: goal.description,
    successCriteria: goal.successCriteria,
    deadlineKind: goal.deadlineKind,
    ...(goal.deadlineAt ? { deadlineAt: iso(goal.deadlineAt) } : {}),
  };
}

function serializeMemory(m: ISemanticMemoryEntry): SerializedCharter['semanticMemory'][number] {
  return { ...m, lastAffirmedAt: iso(m.lastAffirmedAt) };
}

// ── Handoff ────────────────────────────────────────────────────────

export function serializeHandoff(doc: IDeepAgentHandoff): SerializedHandoff {
  return {
    agentId: doc.agentId,
    wakeCount: doc.wakeCount,
    lastWakeAt: iso(doc.lastWakeAt),
    lastActionSummary: doc.lastActionSummary,
    nextIntendedAction: doc.nextIntendedAction,
    ...(doc.nextWakeIntervalMs !== undefined ? { nextWakeIntervalMs: doc.nextWakeIntervalMs } : {}),
    openBlockers: doc.openBlockers,
    ...(doc.lastEpisodeId !== undefined ? { lastEpisodeId: doc.lastEpisodeId } : {}),
    updatedAt: iso(doc.updatedAt),
  };
}

export function deserializeHandoff(handoff: SerializedHandoff): Omit<IDeepAgentHandoff, ManagedDocFields> {
  return {
    agentId: handoff.agentId,
    wakeCount: handoff.wakeCount,
    lastWakeAt: new Date(handoff.lastWakeAt),
    lastActionSummary: handoff.lastActionSummary,
    nextIntendedAction: handoff.nextIntendedAction,
    ...(handoff.nextWakeIntervalMs !== undefined ? { nextWakeIntervalMs: handoff.nextWakeIntervalMs } : {}),
    openBlockers: handoff.openBlockers,
    ...(handoff.lastEpisodeId !== undefined ? { lastEpisodeId: handoff.lastEpisodeId } : {}),
  };
}

// ── Episode ────────────────────────────────────────────────────────

export function serializeEpisode(doc: IDeepAgentEpisode): SerializedEpisode {
  return {
    id: doc.episodeId, // rename: Mongo episodeId → domain id
    agentId: doc.agentId,
    wakeAt: iso(doc.wakeAt),
    drivesBefore: doc.drivesBefore,
    policyDecision: doc.policyDecision,
    actionsTaken: doc.actionsTaken,
    observations: doc.observations,
    reflection: doc.reflection,
    charterDiff: doc.charterDiff,
    drivesAfter: doc.drivesAfter,
    scopeLocks: doc.scopeLocks,
    evidenceTier: doc.evidenceTier,
    tokensSpent: doc.tokensSpent,
    costUsd: doc.costUsd,
    ...(doc.reviewedByEpisodeId !== undefined ? { reviewedByEpisodeId: doc.reviewedByEpisodeId } : {}),
  };
}

export function deserializeEpisode(episode: SerializedEpisode): Omit<IDeepAgentEpisode, ManagedDocFields> {
  return {
    episodeId: episode.id, // rename: domain id → Mongo episodeId
    agentId: episode.agentId,
    wakeAt: new Date(episode.wakeAt),
    drivesBefore: episode.drivesBefore,
    policyDecision: episode.policyDecision,
    actionsTaken: episode.actionsTaken,
    observations: episode.observations,
    reflection: episode.reflection,
    charterDiff: episode.charterDiff,
    drivesAfter: episode.drivesAfter,
    scopeLocks: episode.scopeLocks,
    evidenceTier: episode.evidenceTier,
    tokensSpent: episode.tokensSpent,
    costUsd: episode.costUsd,
    ...(episode.reviewedByEpisodeId !== undefined ? { reviewedByEpisodeId: episode.reviewedByEpisodeId } : {}),
  };
}

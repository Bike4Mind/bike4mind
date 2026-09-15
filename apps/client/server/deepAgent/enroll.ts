import { randomUUID } from 'crypto';
import { Resource } from 'sst';
import {
  CharterSchema,
  DEFAULT_DRIVES,
  type Charter,
  type DeepAgentStore,
  type DriveVector,
  type EvidenceTier,
} from '@bike4mind/agents';
import type { Logger } from '@bike4mind/observability';
import { sendToQueue } from '@server/utils/sqs';
import { MongoDeepAgentStore } from './store';

/**
 * Deep-agent enrollment: the birth of an agent.
 *
 * Seeds a validated Charter (owned by a user) and enqueues its FIRST wake. The
 * scheduler only handles agents that have woken at least once (it keys off the
 * handoff, which the first wake creates), so enrollment is the only thing that
 * bootstraps a brand-new agent. Ongoing cadence is then the agent's own choice
 * via the reflect step's `nextWakeIntervalMs`.
 */
export interface EnrollDeepAgentInput {
  /** The user who owns the agent - tools run as them. */
  ownerUserId: string;
  /** Mission linkage: the B4M AgentModel this mission belongs to (optional). */
  linkedAgentId?: string;
  name: string;
  /** Archetype; selects the toolbelt profile (e.g. 'paper-repro'). */
  role: string;
  goal: {
    description: string;
    successCriteria?: string[];
    deadlineKind?: 'none' | 'soft' | 'hard';
  };
  /** Starting tier; defaults to engineering-proxy. */
  currentTier?: EvidenceTier;
  /** Optional drive overrides on top of the neutral defaults. */
  drives?: Partial<DriveVector>;
  /** Optional charter size budget override. */
  sizeBudgetBytes?: number;
}

export interface EnrollDeepAgentDeps {
  store: Pick<DeepAgentStore, 'saveCharter'>;
  /** Enqueues the agent's first wake. */
  enqueueWake: (agentId: string) => Promise<void>;
  /** Agent id generator (injected for deterministic tests). */
  newAgentId?: () => string;
  /** Clock (injected for tests). */
  now?: () => number;
}

export interface EnrollDeepAgentResult {
  agentId: string;
  charter: Charter;
}

/** Build + persist a charter for a new agent and enqueue its first wake. */
export async function enrollDeepAgent(
  input: EnrollDeepAgentInput,
  deps: EnrollDeepAgentDeps
): Promise<EnrollDeepAgentResult> {
  const agentId = (deps.newAgentId ?? randomUUID)();
  const nowIso = new Date((deps.now ?? Date.now)()).toISOString();

  // Validate at the boundary - a malformed enrollment fails here, not mid-wake.
  const charter: Charter = CharterSchema.parse({
    identity: {
      agentId,
      ownerUserId: input.ownerUserId,
      ...(input.linkedAgentId ? { linkedAgentId: input.linkedAgentId } : {}),
      name: input.name,
      role: input.role,
      instantiatedAt: nowIso,
      schemaVersion: 1,
    },
    goal: {
      description: input.goal.description,
      successCriteria: input.goal.successCriteria ?? [],
      deadlineKind: input.goal.deadlineKind ?? 'none',
    },
    drives: { ...DEFAULT_DRIVES, ...input.drives },
    currentTier: input.currentTier ?? 'engineering-proxy',
    version: 0,
    updatedAt: nowIso,
    // sizeBudgetBytes omitted unless overridden - schema default (8KB) applies.
    ...(input.sizeBudgetBytes !== undefined ? { sizeBudgetBytes: input.sizeBudgetBytes } : {}),
  });

  const saved = await deps.store.saveCharter(charter);
  await deps.enqueueWake(agentId);
  return { agentId, charter: saved };
}

/**
 * Enroll with production deps: Mongo-backed charter store + the wake queue.
 * Callable from an API route, CLI, or seed script.
 */
export async function enrollDeepAgentWithDefaults(
  input: EnrollDeepAgentInput,
  logger: Logger
): Promise<EnrollDeepAgentResult> {
  const result = await enrollDeepAgent(input, {
    store: new MongoDeepAgentStore(),
    enqueueWake: async agentId => {
      await sendToQueue(Resource.deepAgentWakeQueue.url, { agentId });
    },
  });
  logger.info('deep agent enrolled', {
    agentId: result.agentId,
    ownerUserId: input.ownerUserId,
    role: input.role,
  });
  return result;
}

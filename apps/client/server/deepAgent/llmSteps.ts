import { z } from 'zod';
import { randomUUID } from 'crypto';
import {
  DRIVE_KEYS,
  EVIDENCE_TIER_ORDER,
  PolicyDecisionSchema,
  type ActContext,
  type ActResult,
  type Charter,
  type DriveVector,
  type EvidenceTier,
  type GroomContext,
  type OrientContext,
  type PolicyDecision,
  type ReflectContext,
  type ReflectResult,
  type SemanticMemoryEntry,
  type Subgoal,
  type WakeSteps,
} from '@bike4mind/agents';
import { createSmallLLMService, type SmallLLMService } from '@bike4mind/services';
import type { SmallLLMAdapters } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { buildGroomPrompt, buildOrientPrompt, buildReflectPrompt } from './prompts';

/**
 * LLM-backed cognitive steps for the wake cycle.
 *
 * orient / reflect / groom are cheap structured calls via SmallLLMService
 * (Zod-validated JSON, reusing the agents schemas as the output contract). The
 * heavyweight `act` step - a full ReActAgent run with a toolbelt - is injected
 * as `runAct`, so wiring the agent loop stays a separate concern from cognition.
 */

const logger = new Logger({ metadata: { component: 'deepAgent.llmSteps' } });

/**
 * Lenient structured output for the reflect step. Small models (Haiku) routinely
 * return partial drive vectors, zero wake intervals, and loosely-shaped memory /
 * subgoal / blocker entries. We parse permissively and normalize in `reflect()`
 * rather than rejecting + retrying - a wake must never fail on malformed
 * *enrichment*; at worst an unsalvageable entry is dropped. The load-bearing
 * fields (reflection/summary/nextIntendedAction) are the only hard requirements.
 */
// `.catch(fallback)` per field: if ANY single value is malformed (null, wrong
// type, out of range) the field falls back instead of failing the whole parse.
// Small models emit explicit `null`s and odd shapes; a wake must survive all of
// it. Required strings get non-empty placeholders (Mongo requires non-empty).
const ReflectOutputSchema = z.object({
  reflection: z.string().min(1).catch('(no reflection produced)'),
  summary: z.string().min(1).catch('(no summary)'),
  nextIntendedAction: z.string().min(1).catch('(next action undecided)'),
  nextWakeIntervalMs: z.number().nullish().catch(undefined),
  scopeLocks: z.array(z.string()).catch([]),
  drivesAfter: z.record(z.string(), z.number()).catch({}),
  addedSemanticMemory: z.array(z.unknown()).catch([]),
  removedSemanticMemoryIds: z.array(z.unknown()).catch([]),
  subgoalUpdates: z.array(z.unknown()).catch([]),
  openBlockers: z.array(z.unknown()).catch([]),
  charterDiffSummary: z.string().nullish().catch(undefined),
});

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const EVIDENCE_TIERS = EVIDENCE_TIER_ORDER as readonly string[];
const SUBGOAL_STATUSES = ['planned', 'active', 'blocked', 'completed', 'abandoned'];

/** Merge a model-reported partial drive map over the current vector, clamped. */
function normalizeDrives(current: DriveVector, reported: Record<string, number>): DriveVector {
  const next = { ...current };
  for (const key of DRIVE_KEYS) {
    const v = reported[key];
    if (typeof v === 'number' && Number.isFinite(v)) next[key] = clamp01(v);
  }
  return next;
}

/** Best-effort coerce an unknown blocker entry to a human-readable string. */
function coerceString(x: unknown): string {
  if (typeof x === 'string') return x;
  if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    for (const k of ['description', 'blocker', 'text', 'summary', 'title', 'message']) {
      if (typeof o[k] === 'string') return o[k] as string;
    }
    try {
      return JSON.stringify(x);
    } catch {
      return String(x);
    }
  }
  return String(x);
}

function pickString(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) if (typeof o[k] === 'string' && o[k]) return o[k] as string;
  return undefined;
}

/** Salvage loose memory entries into valid SemanticMemoryEntry[]; drop the unsalvageable. */
function normalizeMemory(raw: unknown[], fallbackTier: EvidenceTier, nowIso: string): SemanticMemoryEntry[] {
  const out: SemanticMemoryEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const fact = pickString(o, ['fact', 'text', 'claim', 'content', 'summary']);
    if (!fact) continue;
    out.push({
      id: typeof o.id === 'string' && o.id ? o.id : randomUUID(),
      fact,
      evidenceTier:
        typeof o.evidenceTier === 'string' && EVIDENCE_TIERS.includes(o.evidenceTier)
          ? (o.evidenceTier as EvidenceTier)
          : fallbackTier,
      confidence: typeof o.confidence === 'number' ? clamp01(o.confidence) : 0.5,
      sourceEpisodeIds: Array.isArray(o.sourceEpisodeIds)
        ? (o.sourceEpisodeIds.filter(s => typeof s === 'string') as string[])
        : [],
      lastAffirmedAt: typeof o.lastAffirmedAt === 'string' ? o.lastAffirmedAt : nowIso,
    });
  }
  return out;
}

/** Salvage loose subgoal entries into valid Subgoal[]; drop the unsalvageable. */
function normalizeSubgoals(raw: unknown[], fallbackTier: EvidenceTier): Subgoal[] {
  const out: Subgoal[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const description = pickString(o, ['description', 'text', 'title', 'goal']);
    if (!description) continue;
    out.push({
      id: typeof o.id === 'string' && o.id ? o.id : randomUUID(),
      description,
      status:
        typeof o.status === 'string' && SUBGOAL_STATUSES.includes(o.status)
          ? (o.status as Subgoal['status'])
          : 'planned',
      priority: typeof o.priority === 'number' ? Math.max(0, Math.min(100, Math.round(o.priority))) : 50,
      targetTier:
        typeof o.targetTier === 'string' && EVIDENCE_TIERS.includes(o.targetTier)
          ? (o.targetTier as EvidenceTier)
          : fallbackTier,
      dependsOn: Array.isArray(o.dependsOn) ? (o.dependsOn.filter(s => typeof s === 'string') as string[]) : [],
    });
  }
  return out;
}

/** Groom returns only the compacted memory + questions; identity/goal are preserved locally. */
const GroomOutputSchema = z.object({
  semanticMemory: z.array(z.unknown()).catch([]),
  openQuestions: z.array(z.unknown()).catch([]),
});

export interface LlmWakeStepsConfig {
  /** Backend + model id for the cheap structured steps (orient/reflect/groom). */
  adapters: SmallLLMAdapters;
  /**
   * Executes the act step - typically a ReActAgent run with the role's toolbelt.
   * Injected so the agent-loop wiring is decoupled from cognition.
   */
  runAct: (ctx: ActContext) => Promise<ActResult>;
  /** Per-call timeout for the structured steps. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class LlmWakeSteps implements WakeSteps {
  private readonly llm: SmallLLMService;
  private readonly timeoutMs: number;

  constructor(private readonly config: LlmWakeStepsConfig) {
    this.llm = createSmallLLMService(config.adapters, logger);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async orient(ctx: OrientContext): Promise<PolicyDecision> {
    const { data } = await this.llm.completeJSON(buildOrientPrompt(ctx), PolicyDecisionSchema, {
      taskType: 'classification',
      temperature: 0,
      timeoutMs: this.timeoutMs,
      maxTokens: 2000,
    });
    return data;
  }

  act(ctx: ActContext): Promise<ActResult> {
    return this.config.runAct(ctx);
  }

  async reflect(ctx: ReflectContext): Promise<ReflectResult> {
    const { data } = await this.llm.completeJSON(buildReflectPrompt(ctx), ReflectOutputSchema, {
      taskType: 'extraction',
      temperature: 0,
      timeoutMs: this.timeoutMs,
      // Reflect output is large (drives + memory + subgoals + scope locks);
      // a small ceiling truncates the JSON and breaks parsing.
      maxTokens: 8000,
    });
    // Normalize the model's lenient output into a valid ReflectResult. Malformed
    // enrichment is salvaged or dropped - never fatal to the wake. Timestamp
    // fallbacks use the wake's injected clock so the loop stays deterministic.
    const nowIso = ctx.nowIso ?? new Date().toISOString();
    const tier = ctx.charter.currentTier;
    const drivesAfter = normalizeDrives(ctx.drives, data.drivesAfter);
    const addedSemanticMemory = normalizeMemory(data.addedSemanticMemory, tier, nowIso);
    const subgoalUpdates = normalizeSubgoals(data.subgoalUpdates, tier);
    const removedSemanticMemoryIds = data.removedSemanticMemoryIds.map(coerceString).filter(s => s.length > 0);
    const openBlockers = data.openBlockers.map(coerceString).filter(s => s.length > 0);
    const nextWakeIntervalMs =
      typeof data.nextWakeIntervalMs === 'number' && data.nextWakeIntervalMs > 0
        ? Math.round(data.nextWakeIntervalMs)
        : undefined;

    return {
      reflection: data.reflection,
      summary: data.summary,
      nextIntendedAction: data.nextIntendedAction,
      ...(nextWakeIntervalMs !== undefined ? { nextWakeIntervalMs } : {}),
      scopeLocks: data.scopeLocks,
      drivesAfter,
      // Derive the audit record from the normalized mutations - don't trust the
      // model to also produce a consistent diff.
      charterDiff: {
        addedSemanticMemory: addedSemanticMemory.map(m => m.id),
        removedSemanticMemoryIds,
        subgoalStatusChanges: subgoalUpdates.map(s => s.id),
        summary: data.charterDiffSummary ?? data.summary,
      },
      addedSemanticMemory,
      removedSemanticMemoryIds,
      subgoalUpdates,
      openBlockers,
    };
  }

  async groom(ctx: GroomContext): Promise<Charter> {
    const { data } = await this.llm.completeJSON(buildGroomPrompt(ctx), GroomOutputSchema, {
      taskType: 'summarization',
      temperature: 0,
      timeoutMs: this.timeoutMs,
      maxTokens: 8000,
    });
    // Reconstruct the charter locally: never let the model rewrite identity/goal.
    // Normalize the compacted memory (same leniency as reflect); timestamp
    // fallbacks use the wake's injected clock.
    const nowIso = ctx.nowIso ?? new Date().toISOString();
    return {
      ...ctx.charter,
      semanticMemory: normalizeMemory(data.semanticMemory, ctx.charter.currentTier, nowIso),
      openQuestions: data.openQuestions.map(coerceString).filter(s => s.length > 0),
    };
  }
}

import { z } from 'zod';
import type { ICompletionBackend } from '@bike4mind/llm-adapters';
import {
  DriveVectorSchema,
  EvidenceTierSchema,
  PolicyDecisionSchema,
  summarizeDrives,
  measureCharterSizeBytes,
  type Charter,
  type PolicyDecision,
} from '../schemas';
import { renderActResult, renderCharter, renderHandoff, renderRecentEpisodes } from './prompts';
import { noopRunAct } from './runAct';
import type {
  ActContext,
  ActResult,
  GroomContext,
  OrientContext,
  ReflectContext,
  ReflectResult,
  WakeSteps,
} from './types';

/**
 * Reference cognitive steps for the wake cycle - the open-core default that
 * makes `runWakeCycle` runnable end-to-end with nothing but an
 * `ICompletionBackend`.
 *
 * This is deliberately the *framework reference*, not the production tier:
 *   - prompts are generic (compose the open render helpers)
 *   - parsing is STRICT - the JSON is validated against the schemas and a
 *     malformed response throws.
 *
 * Production deployments swap in their own `WakeSteps` impl with tuned prompts
 * and lenient parsing / memory-grooming heuristics (the recipe that small
 * models need to behave). Keeping that tier private is the Option-C split:
 * the framework is open, the tuned weights are not.
 */

// ── Reference prompts ──────────────────────────────────────────────

/** Reference orient (policy) prompt. Hosts override with a tuned version. */
export function buildReferenceOrientPrompt(ctx: OrientContext): string {
  return [
    'You are the policy step of an autonomous agent waking for one work cycle.',
    'Decide the single next action class that best advances the goal given the',
    'agent’s current drives. Drives are motivational pressures, not orders—',
    'use them to break ties, not to override the goal.',
    '',
    renderCharter(ctx.charter),
    '',
    renderHandoff(ctx.handoff),
    '',
    `Current drives: ${summarizeDrives(ctx.drives)}`,
    '',
    'Recent episodes:',
    renderRecentEpisodes(ctx.recentEpisodes),
    '',
    'Return ONLY a JSON object: the action class to run (`actionKind`), a short',
    '`rationale`, and `expectedDriveDelta` (a map of drive name to expected change',
    'in [-1,1]) describing how you expect this action to move the drives.',
  ].join('\n');
}

/** Reference reflect prompt. Hosts override with a tuned version. */
export function buildReferenceReflectPrompt(ctx: ReflectContext): string {
  return [
    'You are the reflect step of an autonomous agent, closing out one work cycle.',
    'Make meaning of what just happened and how drives should change. Be',
    'conservative: enumerate what you did NOT do this cycle as `scopeLocks` so an',
    'independent reviewer can check your work.',
    '',
    renderCharter(ctx.charter),
    '',
    `Policy decision this cycle: [${ctx.policy.actionKind}] ${ctx.policy.rationale}`,
    `Drives at start: ${summarizeDrives(ctx.drives)}`,
    '',
    renderActResult(ctx.act),
    '',
    'Return ONLY a JSON object with:',
    '- `reflection`: what happened and what was learned',
    '- `summary`: one paragraph for the next wake’s orient prompt',
    '- `nextIntendedAction`: what to do next wake',
    '- `scopeLocks`: array of strings — what was NOT done this cycle',
    '- `drivesAfter`: the full drive vector after this cycle (each in [0,1])',
  ].join('\n');
}

/** Reference groom prompt. Hosts override with a tuned version. */
export function buildReferenceGroomPrompt(ctx: GroomContext): string {
  const measured = measureCharterSizeBytes(ctx.charter);
  return [
    'You are the groom step of an autonomous agent. The charter has grown past',
    `its size budget (${measured} bytes used vs ${ctx.charter.sizeBudgetBytes} budget).`,
    'Compact the semantic memory so the charter fits, WITHOUT losing identity or',
    'goal. Merge redundant facts, drop low-value or stale ones, keep what is most',
    'likely to be needed again.',
    '',
    renderCharter(ctx.charter),
    '',
    'Recent episodes (context for what still matters):',
    renderRecentEpisodes(ctx.recentEpisodes),
    '',
    'Return ONLY a JSON object with `semanticMemory` (array of full memory entries,',
    'each with `id`, `fact`, `evidenceTier`, `confidence`, `sourceEpisodeIds`,',
    '`lastAffirmedAt`) and `openQuestions` (array of strings).',
  ].join('\n');
}

// ── Strict reference output schemas ────────────────────────────────
//
// Load-bearing fields only; enrichment (semantic memory / subgoal mutations)
// is left to the production tier. A malformed response throws - the reference
// favours an obvious failure over silent salvage.

const ReferenceReflectSchema = z.object({
  reflection: z.string().min(1),
  summary: z.string().min(1),
  nextIntendedAction: z.string().min(1),
  scopeLocks: z.array(z.string()).default([]),
  drivesAfter: DriveVectorSchema,
});

const ReferenceGroomSchema = z.object({
  semanticMemory: z.array(
    z.object({
      id: z.string().min(1),
      fact: z.string().min(1),
      evidenceTier: EvidenceTierSchema,
      confidence: z.number().min(0).max(1).default(0.5),
      sourceEpisodeIds: z.array(z.string()).default([]),
      lastAffirmedAt: z.string(),
    })
  ),
  openQuestions: z.array(z.string()).default([]),
});

export interface BackendWakeStepsConfig {
  /** Backend for the structured orient/reflect/groom calls. */
  llm: ICompletionBackend;
  /** Model id for those calls (a small/cheap tier is the typical choice). */
  modelId: string;
  /**
   * The act executor - typically `createReActRunAct(...)`. Defaults to the
   * think-only `noopRunAct`, so the loop runs even before tools are wired.
   */
  runAct?: (ctx: ActContext) => Promise<ActResult>;
  /** Output-token ceiling per structured call. Default 4000. */
  maxTokens?: number;
  /** Sampling temperature for the structured calls. Default 0. */
  temperature?: number;
}

const DEFAULT_MAX_TOKENS = 4000;

/** Accumulate a non-streaming completion to a single string. */
async function completeText(
  llm: ICompletionBackend,
  modelId: string,
  prompt: string,
  maxTokens: number,
  temperature: number
): Promise<string> {
  let text = '';
  await llm.complete(
    modelId,
    [{ role: 'user', content: prompt }],
    { temperature, maxTokens, stream: false, tools: [] },
    async texts => {
      for (const t of texts) if (typeof t === 'string') text += t;
    }
  );
  return text;
}

/**
 * Extract a JSON object from a completion and validate it against `schema`.
 * Reference-grade only: slices from the first `{` to the last `}` and parses
 * that span - not a brace-balanced scan, so prose containing stray braces can
 * make the slice unparseable. That is acceptable here: the reference tier's
 * contract is throw-on-malformed (missing object, invalid JSON, or schema
 * mismatch), and the host's tuned tier owns lenient recovery.
 */
function parseJsonObject<T>(raw: string, schema: z.ZodType<T>): T {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('referenceWakeSteps: no JSON object found in completion');
  }
  return schema.parse(JSON.parse(raw.slice(start, end + 1)));
}

/**
 * Build the reference `WakeSteps` backed by an `ICompletionBackend`. Pairs the
 * reference prompts with strict schema validation; act is injected (defaults to
 * `noopRunAct`).
 */
export function createBackendWakeSteps(config: BackendWakeStepsConfig): WakeSteps {
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  const temperature = config.temperature ?? 0;
  const runAct = config.runAct ?? noopRunAct;

  return {
    async orient(ctx: OrientContext): Promise<PolicyDecision> {
      const raw = await completeText(
        config.llm,
        config.modelId,
        buildReferenceOrientPrompt(ctx),
        maxTokens,
        temperature
      );
      return parseJsonObject(raw, PolicyDecisionSchema);
    },

    act(ctx: ActContext): Promise<ActResult> {
      return runAct(ctx);
    },

    async reflect(ctx: ReflectContext): Promise<ReflectResult> {
      const raw = await completeText(
        config.llm,
        config.modelId,
        buildReferenceReflectPrompt(ctx),
        maxTokens,
        temperature
      );
      const data = parseJsonObject(raw, ReferenceReflectSchema);
      // The reference tier narrates + moves drives; it does not enrich memory or
      // subgoals (that is the production tier's job). The diff records the prose.
      return {
        reflection: data.reflection,
        summary: data.summary,
        nextIntendedAction: data.nextIntendedAction,
        scopeLocks: data.scopeLocks,
        drivesAfter: data.drivesAfter,
        charterDiff: {
          addedSemanticMemory: [],
          removedSemanticMemoryIds: [],
          subgoalStatusChanges: [],
          summary: data.summary,
        },
        addedSemanticMemory: [],
        removedSemanticMemoryIds: [],
        subgoalUpdates: [],
        openBlockers: ctx.charter.blockers,
      };
    },

    async groom(ctx: GroomContext): Promise<Charter> {
      const raw = await completeText(
        config.llm,
        config.modelId,
        buildReferenceGroomPrompt(ctx),
        maxTokens,
        temperature
      );
      const data = parseJsonObject(raw, ReferenceGroomSchema);
      // Reconstruct locally: never let the model rewrite identity/goal.
      const nowIso = ctx.nowIso ?? new Date().toISOString();
      return {
        ...ctx.charter,
        semanticMemory: data.semanticMemory.map(m => ({
          id: m.id,
          fact: m.fact,
          evidenceTier: m.evidenceTier,
          confidence: m.confidence,
          sourceEpisodeIds: m.sourceEpisodeIds,
          lastAffirmedAt: m.lastAffirmedAt || nowIso,
        })),
        openQuestions: data.openQuestions,
      };
    },
  };
}

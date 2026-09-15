import { z } from 'zod';
import { randomUUID } from 'crypto';
import type { Logger } from '@bike4mind/observability';
import { dispatchWithLogger } from '@server/queueHandlers/utils';
import {
  createReActRunAct,
  noopRunAct,
  runWakeCycle,
  type ActContext,
  type ActResult,
  type ToolMaterializer,
  type WakeDeps,
} from '@bike4mind/agents';
import { LlmWakeSteps } from './llmSteps';
import { MongoDeepAgentStore } from './store';
import { loadLinkedAgentContext } from './missions';
import { bridgeWakeToSession } from './missionSessionBridge';
import { createDeepAgentToolMaterializer } from './toolMaterializer';
import { DEFAULT_WAKE_MODEL_ID, resolveDeepAgentBackend } from './resolveBackend';

/**
 * Deep-agent wake trigger. One SQS message -> one wake cycle for one agent.
 *
 * `processWake` is the testable core (inject `deps` to bypass DB + LLM);
 * `buildDefaultWakeDeps` assembles the real Mongo-backed, LLM-backed deps;
 * `dispatch` is the SQS entry point (DB connection + structured logging via
 * `dispatchWithLogger`), following the standard queue-handler pattern.
 */

export const WakePayloadSchema = z.object({
  agentId: z.string().min(1),
  /** Optional model override for cognition; defaults to the light tier. */
  modelId: z.string().optional(),
});

export type WakePayload = z.infer<typeof WakePayloadSchema>;

export interface ProcessWakeOverrides {
  /** Inject fully-formed deps to bypass DB/LLM construction (tests). */
  deps?: WakeDeps;
}

export interface BuildWakeDepsOptions {
  /**
   * Activate the real owner-scoped ReActAgent act step (builds the b4m toolbelt
   * via createDeepAgentToolMaterializer). When false/omitted, act is a
   * think-only no-op (no tools, no token burn) - the safe default.
   */
  enableTools?: boolean;
  /**
   * Explicit tool materializer override (tests / custom toolbelts). Takes
   * precedence over `enableTools`.
   */
  buildTools?: ToolMaterializer;
}

/** Assemble the production wake deps: Mongo store + LLM-backed steps. */
export async function buildDefaultWakeDeps(
  modelId: string | undefined,
  logger: Logger,
  options?: BuildWakeDepsOptions
): Promise<WakeDeps> {
  const resolved = await resolveDeepAgentBackend(modelId ?? DEFAULT_WAKE_MODEL_ID, logger);
  if (!resolved) {
    throw new Error(`deep agent wake: could not resolve model ${modelId ?? DEFAULT_WAKE_MODEL_ID}`);
  }
  // Real ReActAgent act when tools are enabled/supplied; otherwise think-only.
  const buildTools: ToolMaterializer | undefined =
    options?.buildTools ??
    (options?.enableTools
      ? createDeepAgentToolMaterializer({ llm: resolved.llm, model: resolved.modelId, logger })
      : undefined);
  const runAct: (ctx: ActContext) => Promise<ActResult> = buildTools
    ? createReActRunAct({
        llm: resolved.llm,
        model: resolved.modelId,
        logger,
        buildTools,
        loadLinkedAgent: loadLinkedAgentContext,
      })
    : noopRunAct;
  const steps = new LlmWakeSteps({
    adapters: { llm: resolved.llm, modelId: resolved.modelId },
    runAct,
  });
  return {
    store: new MongoDeepAgentStore(),
    steps,
    newEpisodeId: () => randomUUID(),
    logger,
  };
}

/** Run one wake cycle for the payload's agent and log the outcome. */
export async function processWake(
  payload: WakePayload,
  logger: Logger,
  overrides?: ProcessWakeOverrides
): Promise<void> {
  const deps = overrides?.deps ?? (await buildDefaultWakeDeps(payload.modelId, logger));
  const outcome = await runWakeCycle(payload.agentId, deps);
  // Mission log: fire-and-forget - never fails the wake.
  void bridgeWakeToSession(outcome, logger);
  logger.info('deep agent wake complete', {
    agentId: payload.agentId,
    wakeCount: outcome.handoff.wakeCount,
    episodeId: outcome.episode.id,
    tier: outcome.charter.currentTier,
    groomed: outcome.groomed,
    nextWakeIntervalMs: outcome.handoff.nextWakeIntervalMs,
  });
}

export const dispatch = dispatchWithLogger(async (event, _context, logger) => {
  const payload = WakePayloadSchema.parse(JSON.parse(event.Records[0].body));
  logger.updateMetadata({ handler: 'deepAgentWake', agentId: payload.agentId });
  logger.info('Processing deep agent wake');

  await processWake(payload, logger);

  logger.info('Completed deep agent wake');
});

import { randomUUID } from 'crypto';
import type { Logger } from '@bike4mind/observability';
import { createReActRunAct, noopRunAct, runWakeCycle, type WakeDeps, type WakeOutcome } from '@bike4mind/agents';
import { MongoDeepAgentStore } from './store';
import { LlmWakeSteps } from './llmSteps';
import { createDeepAgentToolMaterializer } from './toolMaterializer';
import { loadLinkedAgentContext } from './missions';
import { bridgeWakeToSession } from './missionSessionBridge';
import { DEFAULT_WAKE_MODEL_ID, resolveDeepAgentBackend } from './resolveBackend';

/**
 * Run a freshly-enrolled mission's FIRST wake so it is born alive - the single
 * source of truth shared by the REST create route and the chat `create_mission`
 * tool (which used to carry divergent copies of this assembly). The wake output
 * is bridged into the mission's session fire-and-forget.
 *
 * `enableTools` selects the act strategy: tool-enabled runs act AS the linked
 * agent (persona + tool policy via `loadLinkedAgentContext`); think-only runs
 * (the chat default) orient + reflect without side effects. `timeoutMs` caps
 * each structured step so an inline wake can't starve the caller's runtime.
 */
export interface FirstWakeOptions {
  logger: Logger;
  modelId?: string;
  enableTools?: boolean;
  /** Per-step timeout; default is LlmWakeSteps' own default. */
  timeoutMs?: number;
  /** Internal id of the user this mission belongs to, for provider abuse attribution. */
  userId?: string;
}

export async function runMissionFirstWake(missionId: string, opts: FirstWakeOptions): Promise<WakeOutcome> {
  const resolved = await resolveDeepAgentBackend(opts.modelId ?? DEFAULT_WAKE_MODEL_ID, opts.logger, opts.userId);
  if (!resolved) throw new Error('could not resolve wake model');

  const runAct = opts.enableTools
    ? createReActRunAct({
        llm: resolved.llm,
        model: resolved.modelId,
        logger: opts.logger,
        buildTools: createDeepAgentToolMaterializer({
          llm: resolved.llm,
          model: resolved.modelId,
          logger: opts.logger,
        }),
        loadLinkedAgent: loadLinkedAgentContext,
      })
    : noopRunAct;

  const deps: WakeDeps = {
    store: new MongoDeepAgentStore(),
    steps: new LlmWakeSteps({
      adapters: { llm: resolved.llm, modelId: resolved.modelId },
      runAct,
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    }),
    newEpisodeId: () => randomUUID(),
    logger: opts.logger,
  };

  const outcome = await runWakeCycle(missionId, deps);
  void bridgeWakeToSession(outcome, opts.logger);
  return outcome;
}

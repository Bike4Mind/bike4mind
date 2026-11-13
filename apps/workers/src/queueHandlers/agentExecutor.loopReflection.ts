import {
  getQuestErrorCode,
  LOOP_REFLECT_MAX_TOKENS,
  usdToCredits,
  type IAgentStep,
  type IUserDocument,
} from '@bike4mind/common';
import { buildLoopReflectPrompt, capLoopReflection, parseLoopMemory } from '@bike4mind/common/loops';
import { agentExecutionRepository, loopRepository, User, workItemRepository } from '@bike4mind/database';
import { meterCompletionBackend, type CompletionMeter } from '@bike4mind/services';
import { createSmallLLMService } from '@bike4mind/services/llm/SmallLLMService';
import { completionCeilingUsd, createCompletionMeter } from '@bike4mind/server-utils/billing/meterPlatformCompletion';
import { OperationsModelService } from '@bike4mind/server-utils/services/operationsModelService';
import {
  completeReflection,
  NO_NEXT_ACTION,
  NO_REFLECTION,
  ReflectCoreOutputSchema,
} from '@bike4mind/server-utils/reflection/reflectCore';
import type { Logger } from '@bike4mind/observability';

/** How long a reflection may hold the run (ms); one attempt, no retry, so the hold check prices the whole call. */
export const LOOP_REFLECT_TIMEOUT_MS = 15_000;

export interface LoopReflectRun {
  executionId: string;
  outcome: 'completed' | 'failed';
  /** The raw answer the fold parses (`result.answer`); empty on the failed path. */
  answer: string;
  /** The run's steps; read from the stored checkpoint when omitted. */
  steps?: IAgentStep[];
  failureReason?: string;
  /** The failed path's error; a credit refusal skips the reflection. */
  error?: unknown;
}

/** Tool name and whether it errored, from the observation steps (ReActAgent stamps `toolFailed`). */
function toolSteps(steps: IAgentStep[]): { tool: string; ok: boolean }[] {
  return steps.flatMap(step => {
    if (step.type !== 'observation' || !step.metadata?.toolName) return [];
    return [{ tool: step.metadata.toolName, ok: !(step.metadata as { toolFailed?: boolean }).toolFailed }];
  });
}

/**
 * After a top-level cloud loop run ends (before markComplete / markFailed, so before its fold and next dispatch),
 * makes one metered structured call and stores the reflection on the run, adding its credits to the run's total.
 * Skips triage, desktop, subagent, idle, aborted and budget-stopped runs, and a run whose cap cannot cover the
 * call. Never throws: a failure is logged and the run ends as it would have.
 */
export async function reflectLoopRun(run: LoopReflectRun, logger: Logger): Promise<void> {
  const { executionId, outcome } = run;
  try {
    const execution = await agentExecutionRepository.findById(executionId);
    if (
      !execution?.loopId ||
      execution.parentExecutionId ||
      execution.loopRunKind === 'triage' ||
      execution.runner === 'desktop' ||
      execution.abortedAt ||
      execution.failureReason ||
      getQuestErrorCode(run.error) === 'insufficient_credits'
    ) {
      return;
    }
    const loop = await loopRepository.findById(execution.loopId);
    if (!loop) return;
    // The fold's idle rule minus touched tickets: a goal run that left memory unchanged; idle backoff stays free.
    if (outcome === 'completed' && !execution.workItemId) {
      const next = parseLoopMemory(run.answer, loop.memory);
      if (next.notes === loop.memory.notes && next.nextAction === loop.memory.nextAction) return;
    }

    const ticket = execution.workItemId ? await workItemRepository.findById(execution.workItemId) : null;
    const steps = run.steps ?? (execution.checkpoint as { steps?: IAgentStep[] } | undefined)?.steps ?? [];
    // Failed before its first iteration (setup, model access): nothing to reflect on.
    if (outcome === 'failed' && steps.length === 0) return;
    const prompt = buildLoopReflectPrompt({
      goal: loop.goal,
      ...(ticket && { ticket: { title: ticket.title, stage: execution.loopStage ?? ticket.stage } }),
      outcome,
      failureReason: run.failureReason,
      answer: run.answer,
      steps: toolSteps(steps),
    });

    const { llm, modelInfo, modelId } = await OperationsModelService.getOperationsTextModel({
      endUserId: execution.userId,
    });
    const hold = usdToCredits(
      completionCeilingUsd(modelInfo, [{ role: 'user', content: prompt }], LOOP_REFLECT_MAX_TOKENS)
    );
    if (execution.creditCap != null && execution.creditCap - (execution.totalCreditsUsed ?? 0) < hold) {
      logger.info('[Loops] Reflection skipped: the run cap cannot cover it', { executionId, hold });
      return;
    }
    const user = await User.findById(execution.userId);
    if (!user) return;

    // meterCompletionBackend drops what settle charged; sum it so the run's total matches the ledger. A timed-out
    // call is not cancelled and can settle after the reflection is written, so a late settle adds its own credits.
    let charged = 0;
    let written = false;
    const base = createCompletionMeter(user as IUserDocument, logger, 'loop reflection', {
      organizationId: execution.organizationId,
      sessionId: execution.sessionId,
      systemModel: true,
    });
    const meter: CompletionMeter = async (...args) => {
      const metered = await base(...args);
      return {
        refund: () => metered.refund(),
        settle: async usage => {
          const credits = await metered.settle(usage);
          if (!written) charged += credits;
          else if (credits > 0) {
            await agentExecutionRepository
              .incrementCreditsUsed(executionId, credits)
              .catch(error => logger.warn('[Loops] Could not add a late reflection charge', { executionId, error }));
          }
          return credits;
        },
      };
    };
    const small = createSmallLLMService({ llm: meterCompletionBackend(llm, meter, modelInfo), modelId }, logger);

    let data: { reflection: string; nextIntendedAction: string };
    try {
      data = await completeReflection(small, prompt, ReflectCoreOutputSchema, {
        timeoutMs: LOOP_REFLECT_TIMEOUT_MS,
        maxTokens: LOOP_REFLECT_MAX_TOKENS,
        retries: 0,
      });
    } catch (error) {
      written = true;
      if (charged > 0) await agentExecutionRepository.incrementCreditsUsed(executionId, charged);
      throw error;
    }
    written = true;
    // A placeholder is a malformed reply: bill it, but keep it out of the drawer and the next prompts.
    if (data.reflection === NO_REFLECTION || data.nextIntendedAction === NO_NEXT_ACTION) {
      if (charged > 0) await agentExecutionRepository.incrementCreditsUsed(executionId, charged);
      logger.warn('[Loops] Reflection reply was malformed; not stored', { executionId });
      return;
    }
    await agentExecutionRepository.setLoopReflection(executionId, {
      ...capLoopReflection(data),
      credits: charged,
      createdAt: new Date(),
    });
  } catch (error) {
    logger.warn('[Loops] Run reflection failed', {
      executionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

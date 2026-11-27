/**
 * The image job config for `image_generation` / `edit_image` in agent-mode runs (the parent and its in-process
 * subagents).
 *
 * Chat builds the same config (questProcessor.getImageJobsResolver); agent mode adds the `agentImagesPerRun` per-run
 * cap on top (agentExecutor.generationJobCap.ts), where a batch of N images takes N slots. Without this config the
 * tools render in-process, as they did before image jobs. Image jobs hold and settle their own credits and the job
 * path never calls onStart/onFinish, so nothing here touches agentExecutor.billing.ts.
 */
import type { GenerateImageToolCall } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import type { ImageToolConfig, ImageToolJobsResult } from '@bike4mind/services/llm/tools';
import { createImageJobs, type CreateImageJobsInput } from '@bike4mind/services/imageJobs';
import { BadRequestError, ForbiddenError } from '@bike4mind/utils';
import { getCreateImageJobsDeps } from '@bike4mind/server-utils/generationJobs/wiring';
import {
  limitJobsPerRun,
  questGenerationSlots,
  resolveAgentRunLimit,
  type AgentGenerationSlots,
  type AgentRunLimitCaller,
} from './agentExecutor.generationJobCap';

export const AGENT_IMAGES_SETTING_KEY = 'agentImagesPerRun' as const;

export type AgentImageToolConfigDeps = {
  createJobs(input: CreateImageJobsInput): Promise<ImageToolJobsResult>;
  resolveImageLimit(caller: AgentRunLimitCaller): Promise<number>;
  slots: AgentGenerationSlots;
  logger: Logger;
};

export type BuildAgentImageToolConfigInput = {
  userId: string;
  organizationId?: string;
  /** Set when an API key started the run; such runs keep the in-process render, as in chat. */
  apiKeyId?: string;
  /** The run's real Quest id (resolveExecutionQuestId). */
  questId?: string;
  /** The user's image selection persisted on the execution. */
  selection?: Partial<GenerateImageToolCall>;
  /** Whether the run's toolbelt names image_generation or edit_image; skips the settings read otherwise. */
  toolEnabled: boolean;
};

// createImageJobs asserts model admission (createModelAdmission) before it saves any job; its later failures are
// plain Errors.
const isAdmissionRefusal = (error: unknown): boolean =>
  error instanceof ForbiddenError || error instanceof BadRequestError;

const imageLimitRefusal = (limit: number): ImageToolJobsResult => ({
  ok: false,
  status: 403,
  code: 'image_limit_reached',
  message: `This run has already started its limit of ${limit} image${limit === 1 ? '' : 's'}, or this request would pass it. Do not retry; tell the user the limit was reached.`,
});

/**
 * Null keeps the in-process image tools: not in the toolbelt, an API-key run, no Quest to count on or attach the
 * cards to, or a failed limit read (fail toward the old path rather than an uncapped job path).
 */
export async function buildAgentImageToolConfig(
  { userId, organizationId, apiKeyId, questId, selection, toolEnabled }: BuildAgentImageToolConfigInput,
  deps: AgentImageToolConfigDeps
): Promise<ImageToolConfig | null> {
  if (!toolEnabled || apiKeyId || !questId) return null;
  try {
    const limit = await deps.resolveImageLimit({ userId, organizationId });
    return {
      // The execution doc persists a Partial; the tools read every field as optional.
      selection: selection as GenerateImageToolCall | undefined,
      createJobs: limitJobsPerRun(deps.createJobs, {
        questId,
        limit,
        slots: deps.slots,
        logger: deps.logger,
        logTag: '[AgentImage]',
        releaseNoun: 'image',
        refusal: imageLimitRefusal(limit),
        slotsFor: input => input.count,
        isThrownBeforePersist: isAdmissionRefusal,
      }),
    };
  } catch (error) {
    deps.logger.warn('[AgentImage] could not build the image job config; images render in-process this invocation', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function getAgentImageToolConfigDeps(logger: Logger): AgentImageToolConfigDeps {
  return {
    createJobs: input => createImageJobs(input, getCreateImageJobsDeps()),
    resolveImageLimit: resolveAgentRunLimit(AGENT_IMAGES_SETTING_KEY, logger),
    slots: questGenerationSlots('image'),
    logger,
  };
}

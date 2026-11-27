import { ModelInfo } from '@bike4mind/common';
import { estimateImageCredits } from '../imageCost';
import { toImageCostInput, type ImageToolCostInput } from './tools/imageToolBilling';

/**
 * Provider media-cost (USD) of one generative-tool call, for the AGENT-MODE billing rail.
 *
 * The classic-chat path bills these tools through `ToolBuilder` + `toolCreditsMap` +
 * `ChatCompletionProcess` (gate-on-start / settle-on-finish). Agent mode does not run
 * that path at all - it bills per iteration in `billIteration`, folding a tool's cost into
 * `pendingToolUsage.costUsd` (see agentExecutor). This maps the same `onToolStart` /
 * `onToolFinish` payloads the tools already emit to a USD figure the agent rail can charge,
 * reusing the exact estimators the direct endpoints and the classic-chat host use so a
 * tool-driven generation bills identically however it was invoked.
 *
 * Returns 0 for a non-media tool or a payload missing the fields the estimator needs; the
 * estimators themselves throw on an unsupported model / non-finite cost, so the caller wraps
 * this and logs rather than letting a cost-estimate edge crash the agent run.
 *
 * Timing mirrors the classic host: images settle from the `onToolFinish` payload so only a
 * delivered image is billed. video_generation, music_generation and audio_generation are not
 * here: their jobs hold and settle credits themselves.
 */
export function estimateGeneratedMediaUsd(toolName: string, data: unknown, models: ModelInfo[]): number {
  switch (toolName) {
    case 'image_generation':
    case 'edit_image': {
      const d = data as ImageToolCostInput;
      if (!d?.model) return 0;
      const modelInfo = models.find(m => m.id === d.model);
      if (!modelInfo) return 0;
      return estimateImageCredits(modelInfo, d.n || 1, toImageCostInput(toolName, d)).usdCost;
    }
    default:
      return 0;
  }
}

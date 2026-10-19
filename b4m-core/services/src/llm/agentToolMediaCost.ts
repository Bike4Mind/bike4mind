import { ModelInfo, SoundGenerationVendor, VoiceGenerationVendor } from '@bike4mind/common';
import { estimateImageCredits } from '../imageCost';
import { AudioCostInput, estimateAudioCredits } from '../audioCost';
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
 * Timing mirrors the classic host: image and audio both settle from the `onToolFinish`
 * payload so only a delivered image or clip is billed. video_generation and music_generation are
 * not here: their jobs hold and settle credits themselves.
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
    case 'audio_generation': {
      const d = data as {
        kind?: string;
        provider?: string;
        model?: string;
        characters?: number;
        durationSeconds?: number;
      };
      if (!d?.provider) return 0;
      const input: AudioCostInput =
        d.kind === 'sound_effect'
          ? { kind: 'sound_effect', provider: d.provider as SoundGenerationVendor, durationSeconds: d.durationSeconds }
          : {
              kind: 'speech',
              provider: d.provider as VoiceGenerationVendor,
              model: d.model,
              characters: d.characters ?? 0,
            };
      return estimateAudioCredits(input).usdCost;
    }
    default:
      return 0;
  }
}

import { ModelInfo, MusicGenerationVendor, SoundGenerationVendor, VoiceGenerationVendor } from '@bike4mind/common';
import { estimateImageCredits } from '../imageCost';
import { estimateMusicCredits } from '../musicCost';
import { AudioCostInput, estimateAudioCredits } from '../audioCost';
import { CostInput } from './imageCostCalculator/types';

/**
 * Provider media-cost (USD) of one generative-tool call, for the AGENT-MODE billing rail.
 *
 * The classic-chat path bills these tools through `ToolBuilder` + `toolCreditsMap` +
 * `ChatCompletionProcess` (reserve-on-start / settle-on-finish). Agent mode does not run
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
 * Timing mirrors the classic host: image cost is known up front (from n/size/quality) so it
 * is read from the `onToolStart` payload; music/audio settle from the `onToolFinish` payload
 * so only a delivered clip is billed.
 */
export function estimateGeneratedMediaUsd(toolName: string, data: unknown, models: ModelInfo[]): number {
  switch (toolName) {
    case 'image_generation':
    case 'edit_image': {
      const d = data as { model?: string; n?: number; size?: string; quality?: string };
      if (!d?.model) return 0;
      const modelInfo = models.find(m => m.id === d.model);
      if (!modelInfo) return 0;
      // Runtime tool args are untyped strings; the calculator narrows by model backend.
      const input = { model: d.model, size: d.size, quality: d.quality } as CostInput;
      return estimateImageCredits(modelInfo, d.n || 1, input).usdCost;
    }
    case 'music_generation': {
      const d = data as { provider?: MusicGenerationVendor; lengthMs?: number };
      if (!d?.provider || typeof d.lengthMs !== 'number') return 0;
      return estimateMusicCredits(d.provider, { lengthMs: d.lengthMs }).usdCost;
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

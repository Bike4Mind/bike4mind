import { IModelPriceTier } from './types/entities/ModelPriceTypes';

/** Token counts a realtime voice session reports at end (provider-reported). */
export interface RealtimeVoiceUsage {
  textInputTokens: number;
  textCachedInputTokens: number;
  textOutputTokens: number;
  audioInputTokens: number;
  audioCachedInputTokens: number;
  audioOutputTokens: number;
}

/**
 * True when the tier carries the rates realtime voice settlement needs.
 * A text-only tier must not settle a voice session: audio tokens would
 * multiply against 0 and the session would bill (nearly) free.
 */
export function isRealtimeVoiceTier(tier: IModelPriceTier): boolean {
  return tier.input > 0 && tier.output > 0 && (tier.audio_input ?? 0) > 0 && (tier.audio_output ?? 0) > 0;
}

/**
 * Total provider USD for one realtime voice session. Absent cached rates
 * charge at the full input rate: fail-safe toward overcharge-then-reprice,
 * never toward free. Callers convert to credits ONCE (settlement draws
 * stochastic per pricing.ts policy); summing here is what removed the old
 * per-component ceil that overcharged up to ~6 credits per session.
 */
export function computeRealtimeVoiceUsd(tier: IModelPriceTier, usage: RealtimeVoiceUsage): number {
  const textCached = tier.cache_read ?? tier.input;
  const audioInput = tier.audio_input ?? 0;
  const audioCached = tier.audio_cache_read ?? audioInput;
  const audioOutput = tier.audio_output ?? 0;
  return (
    tier.input * usage.textInputTokens +
    textCached * usage.textCachedInputTokens +
    tier.output * usage.textOutputTokens +
    audioInput * usage.audioInputTokens +
    audioCached * usage.audioCachedInputTokens +
    audioOutput * usage.audioOutputTokens
  );
}

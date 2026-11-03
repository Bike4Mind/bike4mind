import type { FitModel, FitRuntime, HardwareProfile } from './fit';

const GIB = 1024 ** 3;

/** Memory bandwidth a decode step sees, by chip, matched against the probe's chip and GPU names. */
export const CHIP_BANDWIDTH: ReadonlyArray<{ match: RegExp; bytesPerSec: number }> = [
  // Measured: dense weights times decode speed held at 196 to 216 GiB/s.
  { match: /\bN1X\b/i, bytesPerSec: 200 * GIB },
];

export const DECODE_CONSTANTS = {
  // A 25B MoE with 3.8B active decoded at about half the rate its active weights predict.
  moeOverhead: 2,
  // Under the 1.8x to 2.2x measured with MTP on prose; code and long chats are unmeasured.
  speculativeGain: 1.5,
} as const;

export interface DecodeEstimate {
  /** Reply tokens per second while the context is nearly empty; K/V reads as it fills are not counted. */
  tokensPerSec: number;
  /** Weight bytes read per token, MoE overhead included. */
  bytesPerToken: number;
  bandwidthBytesPerSec: number;
}

/** Bandwidth entered for the machine, else the chip table's; null when neither knows it. */
export function memoryBandwidth(hw: HardwareProfile): number | null {
  if (hw.memoryBandwidthBytesPerSec) return hw.memoryBandwidthBytesPerSec;
  const names = [hw.chip, hw.gpuName].filter((name): name is string => !!name);
  return CHIP_BANDWIDTH.find(chip => names.some(name => chip.match.test(name)))?.bytesPerSec ?? null;
}

/** A catalog entry's active share of its parameters; undefined for a dense model. */
export function activeParamsFraction(params: { totalB: number; activeB: number | null }): number | undefined {
  return params.activeB === null ? undefined : params.activeB / params.totalB;
}

/**
 * Bytes one decode step reads: every weight on a dense model; on MoE the active weights, from tensor stats or the
 * active parameter share, times the overhead. Null for an MoE model with neither.
 */
export function decodeBytesPerToken(model: FitModel): number | null {
  const { moe } = model.arch;
  if (!moe) return model.weightsBytes;
  const expertBytes = moe.moeLayers * (model.expertBytesPerLayer ?? 0);
  let active: number | null = null;
  // As in activationBytesPerToken: a library blob smaller than the hub build's tensor stats falls back.
  if (expertBytes && expertBytes < model.weightsBytes) {
    active = model.weightsBytes - expertBytes * (1 - moe.used / moe.experts);
  } else if (model.activeParamsFraction) {
    active = model.weightsBytes * model.activeParamsFraction;
  }
  return active === null ? null : active * DECODE_CONSTANTS.moeOverhead;
}

/** Bandwidth over the bytes read per token, times the speculative gain when a preset turns it on. */
export function estimateDecode(model: FitModel, hw: HardwareProfile, runtime: FitRuntime): DecodeEstimate | null {
  const bandwidth = memoryBandwidth(hw);
  const bytes = decodeBytesPerToken(model);
  if (!bandwidth || !bytes) return null;
  const gain = runtime.speculative ? DECODE_CONSTANTS.speculativeGain : 1;
  return { tokensPerSec: (bandwidth / bytes) * gain, bytesPerToken: bytes, bandwidthBytesPerSec: bandwidth };
}

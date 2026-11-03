import type { FitModel, FitRuntime, HardwareProfile } from './fit';

const GIB = 1024 ** 3;
const GB = 1e9;

export const DECODE_CONSTANTS = {
  // Share of a spec-sheet bandwidth a decode step sees. Assumed: the measured N1X has no published spec.
  bandwidthEfficiency: 0.8,
  // A 25B MoE with 3.8B active decoded at about half the rate its active weights predict.
  moeOverhead: 2,
  // Under the 1.8x to 2.2x measured with MTP on prose; code and long chats are unmeasured.
  speculativeGain: 1.5,
} as const;

// Matched against the probe's chip, which on a Mac is the CPU brand string.
const apple = (chip: string, gbps: number) => ({ match: new RegExp(`^Apple ${chip}$`, 'i'), gbps });
// Matched against nvidia-smi's name; the end anchor keeps Ti and Laptop GPU parts out.
const geforce = (card: string, gbps: number) => ({ match: new RegExp(`\\bRTX ${card}$`, 'i'), gbps });

/** Spec-sheet memory bandwidth in decimal GB/s by chip; a binned Max takes its lower figure. */
export const CHIP_BANDWIDTH: ReadonlyArray<{ match: RegExp; gbps: number }> = [
  // Measured at 196 to 216 GiB/s of dense decode; listed so the efficiency factor gives 200 GiB/s back.
  { match: /\bN1X\b/i, gbps: (200 * GIB) / GB / DECODE_CONSTANTS.bandwidthEfficiency },
  apple('M1 Pro', 200),
  apple('M1 Max', 400),
  apple('M1 Ultra', 800),
  apple('M2', 100),
  apple('M2 Pro', 200),
  apple('M2 Max', 400),
  apple('M2 Ultra', 800),
  apple('M3', 100),
  apple('M3 Pro', 150),
  apple('M3 Max', 300),
  apple('M3 Ultra', 819),
  apple('M4', 120),
  apple('M4 Pro', 273),
  apple('M4 Max', 410),
  apple('M5', 153),
  apple('M5 Pro', 307),
  apple('M5 Max', 460),
  geforce('5060 Ti', 448),
  geforce('5070', 672),
  geforce('5070 Ti', 896),
  geforce('5080', 960),
  geforce('5090', 1792),
  // Ryzen AI Max: the Windows driver name, the pci.ids name, or the bare device id when pci.ids is missing.
  { match: /\b(?:8040S|8050S|8060S)\b|\bStrix Halo\b|\[1002:1586\]/i, gbps: 256 },
];

export interface DecodeEstimate {
  /** Reply tokens per second while the context is nearly empty; K/V reads as it fills are not counted. */
  tokensPerSec: number;
  /** Weight bytes read per token, MoE overhead included. */
  bytesPerToken: number;
  /** The spec figure times bandwidthEfficiency. */
  bandwidthBytesPerSec: number;
}

/** Bandwidth entered for the machine, else the chip table's, scaled to what decode sees; null when neither knows it. */
export function memoryBandwidth(hw: HardwareProfile): number | null {
  const names = [hw.chip, hw.gpuName].filter((name): name is string => !!name);
  const spec =
    hw.memoryBandwidthBytesPerSec ||
    (CHIP_BANDWIDTH.find(chip => names.some(name => chip.match.test(name)))?.gbps ?? 0) * GB;
  return spec ? spec * DECODE_CONSTANTS.bandwidthEfficiency : null;
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

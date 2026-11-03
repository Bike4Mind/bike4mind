import { describe, expect, it } from 'vitest';
import { ModelArchSchema } from '../schemas/modelHub';
import { machine } from './__fixtures__/hubManifest';
import { DECODE_CONSTANTS, activeParamsFraction, decodeBytesPerToken, estimateDecode, memoryBandwidth } from './decode';
import type { FitModel, HardwareProfile } from './fit';

const GIB = 1024 ** 3;

const DENSE = ModelArchSchema.parse({
  contextMax: 262144,
  blockCount: 64,
  full: { layers: 16, kvHeads: 4, keyLength: 256, valueLength: 256 },
});
const MOE = ModelArchSchema.parse({
  contextMax: 262144,
  blockCount: 30,
  full: { layers: 30, kvHeads: 8, keyLength: 256, valueLength: 256 },
  moe: { experts: 128, used: 8, moeLayers: 30 },
});

// The probe's GPU name on the machine the measurements came from.
const N1X: HardwareProfile = {
  ...machine('unified', 128),
  gpuName: 'NVIDIA RTX Spark N1X (6144-core Blackwell RTX GPU)',
};
const LS = { kind: 'llama-server' } as const;

describe('memoryBandwidth', () => {
  it('takes the chip table figure for a known chip', () => {
    expect(memoryBandwidth(N1X)).toBe(200 * GIB);
    expect(memoryBandwidth({ ...machine('unified', 128), chip: 'Spark N1X' })).toBe(200 * GIB);
  });

  it('prefers entered bandwidth over the chip table', () => {
    expect(memoryBandwidth({ ...N1X, memoryBandwidthBytesPerSec: 256e9 })).toBe(256e9);
    expect(memoryBandwidth({ ...machine('discrete', 64, 24), memoryBandwidthBytesPerSec: 1008e9 })).toBe(1008e9);
  });

  it('knows nothing about an unlisted chip', () => {
    expect(memoryBandwidth({ ...machine('discrete', 64, 24), gpuName: 'Some GPU' })).toBeNull();
    expect(estimateDecode({ arch: DENSE, weightsBytes: 15 * GIB }, machine('unified', 64), LS)).toBeNull();
  });
});

describe('decodeBytesPerToken', () => {
  it('reads every weight of a dense model', () => {
    expect(decodeBytesPerToken({ arch: DENSE, weightsBytes: 15 * GIB })).toBe(15 * GIB);
  });

  it('reads the active MoE weights from tensor stats, times the overhead', () => {
    const model: FitModel = { arch: MOE, weightsBytes: 14 * GIB, expertBytesPerLayer: 0.4 * GIB };
    const active = 14 * GIB - 30 * 0.4 * GIB * (1 - 8 / 128);
    expect(decodeBytesPerToken(model)).toBeCloseTo(active * DECODE_CONSTANTS.moeOverhead, 0);
  });

  it('falls back to the active parameter share, and has no figure without either', () => {
    const share = activeParamsFraction({ totalB: 20, activeB: 4 });
    expect(share).toBe(0.2);
    expect(decodeBytesPerToken({ arch: MOE, weightsBytes: 10 * GIB, activeParamsFraction: share })).toBeCloseTo(
      2 * GIB * DECODE_CONSTANTS.moeOverhead,
      0
    );
    expect(decodeBytesPerToken({ arch: MOE, weightsBytes: 10 * GIB })).toBeNull();
    expect(activeParamsFraction({ totalB: 27, activeB: null })).toBeUndefined();
  });
});

// Decode speeds measured on the N1X with a nearly empty context (weights in GiB, tok/s without and with MTP).
const DENSE_ROWS = [
  { quant: 'Q4_K_M', weightsGiB: 15.33, measured: 12.8, mtp: 23.5 },
  { quant: 'Q8_0', weightsGiB: 27.05, measured: 8.0, mtp: 17.5 },
  { quant: 'BF16', weightsGiB: 50.9, measured: 4.1, mtp: 9.1 },
];
const MOE_ROW = { weightsGiB: 14.6, totalB: 25.2, activeB: 3.8, measuredLow: 43.6, measuredHigh: 48.9 };

describe('estimateDecode against the measured table', () => {
  it.each(DENSE_ROWS)('lands within 15% of the dense $quant row', ({ weightsGiB, measured }) => {
    const estimate = estimateDecode({ arch: DENSE, weightsBytes: weightsGiB * GIB }, N1X, LS);
    expect(Math.abs((estimate?.tokensPerSec ?? 0) / measured - 1)).toBeLessThan(0.15);
  });

  it.each(DENSE_ROWS)(
    'stays between the measured speeds without and with MTP on $quant',
    ({ weightsGiB, measured, mtp }) => {
      const model = { arch: DENSE, weightsBytes: weightsGiB * GIB };
      const plain = estimateDecode(model, N1X, LS)?.tokensPerSec ?? 0;
      const speculative = estimateDecode(model, N1X, { ...LS, speculative: true })?.tokensPerSec ?? 0;
      expect(speculative).toBeCloseTo(plain * DECODE_CONSTANTS.speculativeGain, 6);
      expect(speculative).toBeGreaterThan(measured);
      expect(speculative).toBeLessThan(mtp);
    }
  );

  it('lands the MoE row inside its measured range through the overhead', () => {
    const { weightsGiB, totalB, activeB, measuredLow, measuredHigh } = MOE_ROW;
    const model: FitModel = {
      arch: MOE,
      weightsBytes: weightsGiB * GIB,
      activeParamsFraction: activeParamsFraction({ totalB, activeB }),
    };
    const estimate = estimateDecode(model, N1X, LS);
    expect(estimate?.tokensPerSec).toBeGreaterThanOrEqual(measuredLow);
    expect(estimate?.tokensPerSec).toBeLessThanOrEqual(measuredHigh);
    expect(estimate?.bandwidthBytesPerSec).toBe(200 * GIB);
  });
});

import type { HardwareProfile } from '@bike4mind/common';
import { specsRate, type ModelServerSpecs } from '@shared/modelServers';

const GIB = 1024 ** 3;

/**
 * This computer's probe with the memory entered in Settings in its place. The probe still decides unified memory;
 * GPU memory entered on a machine the probe found no GPU in makes it a discrete GPU of unknown vendor.
 */
export function withEnteredSpecs<T extends HardwareProfile>(probed: T, specs: ModelServerSpecs | null): T {
  if (!specsRate(specs)) return probed;
  const gpu = specs.gpuMemoryGiB === null ? null : specs.gpuMemoryGiB * GIB;
  const next: T = { ...probed };
  if (specs.ramGiB !== null) next.totalMemoryBytes = specs.ramGiB * GIB;
  if (gpu !== null) {
    next.gpuMemoryBytes = gpu;
    next.confidence = 'high';
    if (probed.memoryKind === 'cpu') {
      next.memoryKind = 'discrete';
      next.gpuCount = Math.max(1, probed.gpuCount);
      delete next.gpuVendor;
    }
  }
  return next;
}

/** A saved server's hardware from its entered specs; null when they do not include RAM, so it stays unrated. */
export function serverHardware(specs: ModelServerSpecs | null): HardwareProfile | null {
  if (!specs || specs.ramGiB === null) return null;
  const gpu = specs.gpuMemoryGiB === null ? null : specs.gpuMemoryGiB * GIB;
  return {
    platform: 'unknown',
    arch: 'unknown',
    memoryKind: specs.unified ? 'unified' : gpu ? 'discrete' : 'cpu',
    totalMemoryBytes: specs.ramGiB * GIB,
    gpuMemoryBytes: gpu,
    gpuName: null,
    gpuCount: gpu && !specs.unified ? 1 : 0,
    chip: null,
    diskFreeBytes: null,
    confidence: 'high',
  };
}

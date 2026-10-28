import type { HubTier } from '../schemas/modelHub';
import type { HardwareProfile } from './fit';

const GIB = 1024 ** 3;
// Memory reads a little under the size it is sold as: a 16 GB card reports about 15.9 GiB, a 32 GB PC about 31.3 GiB.
const SOLD_SIZE_SLACK = 0.94;

export interface HardwareClass {
  memoryKind: HubTier['memoryKind'];
  /** GPU memory on a discrete GPU or AMD unified memory, total memory otherwise. */
  memoryBytes: number;
}

/** A discrete machine whose GPU memory is unknown is planned, and so classed, as CPU only. */
export function hardwareClass(hw: HardwareProfile): HardwareClass {
  // Only AMD unified memory reports gpuMemoryBytes: what ROCm can allocate, which a firmware carve-out keeps outside
  // totalMemoryBytes. A low-confidence figure is already the smaller of the pools ROCm might use.
  if (hw.memoryKind === 'unified')
    return {
      memoryKind: 'unified',
      memoryBytes: hw.gpuMemoryBytes && hw.gpuMemoryBytes > 0 ? hw.gpuMemoryBytes : hw.totalMemoryBytes,
    };
  // gpuMemoryBytes sums every GPU, which Ollama splits layers across.
  if (hw.memoryKind === 'discrete' && hw.gpuMemoryBytes)
    return { memoryKind: 'discrete', memoryBytes: hw.gpuMemoryBytes };
  return { memoryKind: 'cpu', memoryBytes: hw.totalMemoryBytes };
}

/** The largest tier with picks of this machine's class that its memory reaches; null when the list has none. */
export function curatedTier(tiers: readonly HubTier[], hw: HardwareProfile): HubTier | null {
  const { memoryKind, memoryBytes } = hardwareClass(hw);
  let best: HubTier | null = null;
  for (const tier of tiers)
    if (
      tier.picks.length > 0 &&
      tier.memoryKind === memoryKind &&
      memoryBytes >= tier.minGiB * GIB * SOLD_SIZE_SLACK &&
      (!best || tier.minGiB > best.minGiB)
    )
      best = tier;
  return best;
}

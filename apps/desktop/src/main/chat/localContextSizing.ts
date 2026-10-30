import { archFromModelInfo, probeHardware, type HardwareProfile, type ModelArch } from '@bike4mind/local-models';
import type { LocalContextSetting } from '@shared/localContextSetting';
import type { LocalModelFootprint } from './localContext';
import type { LocalContextSizing, LocalModelFacts } from './OllamaLocal';

/** One hardware probe per app run for everything that sizes local models; main starts it at launch. */
export class HardwareProbe {
  private pending: Promise<HardwareProfile | null> | undefined;
  private result: HardwareProfile | null | undefined;
  private retryAt = 0;
  private override: (probed: HardwareProfile) => HardwareProfile = probed => probed;

  constructor(
    private readonly probe: () => Promise<HardwareProfile> = () => probeHardware(),
    private readonly now: () => number = Date.now
  ) {}

  /** What sizing reads in place of the probe, such as hardware entered in Settings. */
  setOverride(override: (probed: HardwareProfile) => HardwareProfile): void {
    this.override = override;
  }

  /** The probe with any override applied; null after a failed probe, which is tried again a minute later. */
  async profile(): Promise<HardwareProfile | null> {
    const probed = await this.probed();
    return probed && this.override(probed);
  }

  /** What the probe found, before any override. */
  probed(): Promise<HardwareProfile | null> {
    if (this.result === null && this.now() >= this.retryAt) this.pending = undefined;
    this.pending ??= this.probe().then(
      profile => (this.result = profile),
      () => {
        this.retryAt = this.now() + RETRY_AFTER_MS;
        return (this.result = null);
      }
    );
    return this.pending;
  }

  /** Undefined while the probe has not finished. */
  known(): HardwareProfile | null | undefined {
    return this.result && this.override(this.result);
  }
}

export const localHardware = new HardwareProbe();

export interface LocalContextSizingDeps {
  setting(): Promise<LocalContextSetting>;
  hardware?: HardwareProbe;
  /** `/api/show` with verbose on: model_info with every per-layer array. */
  showVerbose?(model: string): Promise<{ model_info?: Record<string, unknown> | null; tensors?: unknown }>;
  now?(): number;
}

const OLLAMA_URL = 'http://127.0.0.1:11434';
// A verbose show carries the whole tokenizer, about 9 MB for gpt-oss-20b; the plain show's 1 s is too tight.
const VERBOSE_SHOW_TIMEOUT_MS = 3_000;
const RETRY_AFTER_MS = 60_000;
const MAX_RETRY_AFTER_MS = 10 * 60_000;
// Mirrors needsVerboseShow in b4m-core/local-models/src/ollama.ts, minus expert tensors, which Ollama never offloads.
const PER_LAYER_KEYS = [
  'attention.head_count_kv',
  'attention.head_count',
  'attention.recurrent_layers',
  'attention.sliding_window_pattern',
];

function truncatedPerLayer(modelInfo: Record<string, unknown> | undefined): boolean {
  const arch = modelInfo?.['general.architecture'];
  if (!modelInfo || typeof arch !== 'string') return false;
  return PER_LAYER_KEYS.some(key => {
    const value = modelInfo[`${arch}.${key}`];
    return value === null || (Array.isArray(value) && value.length === 0);
  });
}

async function verboseShow(model: string) {
  const response = await fetch(`${OLLAMA_URL}/api/show`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, verbose: true }),
    signal: AbortSignal.timeout(VERBOSE_SHOW_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}.`);
  return (await response.json()) as { model_info?: Record<string, unknown> | null; tensors?: unknown };
}

interface ArchEntry {
  digest: string | undefined;
  arch: ModelArch | null;
  pending?: Promise<ModelArch | null>;
  /** After a failed verbose show: no new attempt before this time. */
  retryAt?: number;
  failures: number;
}

/**
 * A model's shape from the `/api/show` OllamaLocal made (verbose only when per-layer arrays are missing),
 * kept per digest until Settings change. A failed verbose show is retried after a growing pause.
 */
export function localContextSizing({
  setting,
  hardware = localHardware,
  showVerbose = verboseShow,
  now = Date.now,
}: LocalContextSizingDeps): LocalContextSizing {
  const arches = new Map<string, ArchEntry>();

  const entryFor = (facts: LocalModelFacts): ArchEntry => {
    const known = arches.get(facts.name);
    if (known && known.digest === facts.digest && (known.retryAt === undefined || now() < known.retryAt)) return known;
    // Listed while /api/show was too slow to answer: unknown for now, not for the rest of the run.
    if (!facts.modelInfo) return { digest: facts.digest, arch: null, failures: 0 };
    const failures = known && known.digest === facts.digest ? known.failures : 0;
    if (!truncatedPerLayer(facts.modelInfo)) {
      const entry = { digest: facts.digest, arch: archFromModelInfo(facts.modelInfo), failures: 0 };
      arches.set(facts.name, entry);
      return entry;
    }
    const entry: ArchEntry = { digest: facts.digest, arch: null, failures };
    entry.pending = showVerbose(facts.name).then(
      shown => {
        entry.arch = archFromModelInfo(shown.model_info, shown.tensors);
        entry.retryAt = undefined;
        entry.failures = 0;
        return entry.arch;
      },
      () => {
        entry.failures += 1;
        entry.retryAt = now() + Math.min(RETRY_AFTER_MS * 2 ** (entry.failures - 1), MAX_RETRY_AFTER_MS);
        return null;
      }
    );
    arches.set(facts.name, entry);
    return entry;
  };

  const footprintOf = (facts: LocalModelFacts, arch: ModelArch | null, machine: HardwareProfile | null) => ({
    arch,
    weightsBytes: facts.sizeBytes ?? null,
    hardware: machine,
  });

  return {
    setting,
    async footprint(facts): Promise<LocalModelFootprint> {
      const entry = entryFor(facts);
      const [arch, machine] = await Promise.all([entry.pending ?? entry.arch, hardware.profile()]);
      return footprintOf(facts, arch, machine);
    },
    cachedFootprint(facts): LocalModelFootprint {
      void hardware.profile();
      return footprintOf(facts, entryFor(facts).arch, hardware.known() ?? null);
    },
    forget() {
      arches.clear();
    },
  };
}

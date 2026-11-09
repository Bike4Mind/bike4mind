import {
  LISTING_TIMEOUT_MS,
  archFromModelInfo,
  binaryIdentity,
  modelBlobsOf,
  probeHardware,
  withTimeout,
  type HardwareProbeOptions,
  type HardwareProfile,
  type LlamaServerLocation,
  type ModelArch,
} from '@bike4mind/local-models';
import type { LocalContextSetting } from '@shared/localContextSetting';
import type { FlashAttention, ModelServerView, QuantizedKvCacheType } from '@shared/modelServers';
import { installedProjectorBytes } from '../models/projectorBytes';
import type { LocalModelFootprint } from './localContext';
import type { LocalContextSizing, LocalModelFacts } from './OllamaLocal';

/** One hardware probe per app run for everything that sizes local models; main starts it at launch. */
export class HardwareProbe {
  private pending: Promise<HardwareProfile | null> | undefined;
  private result: HardwareProfile | null | undefined;
  private retryAt = 0;
  private override: (probed: HardwareProfile) => HardwareProfile = probed => probed;
  private llamaServer: HardwareProbeOptions['llamaServer'];
  /** The identity of the llama-server the current result's probe found: null for none, undefined when unknown. */
  private listedBinary: string | null | undefined;
  private relist = false;

  constructor(
    private readonly probe: (options: HardwareProbeOptions) => Promise<HardwareProfile> = options =>
      probeHardware(options),
    private readonly now: () => number = Date.now,
    private readonly identify: (path: string) => Promise<string> = binaryIdentity,
    private readonly locateTimeoutMs: number = LISTING_TIMEOUT_MS
  ) {}

  /** What sizing reads in place of the probe, such as hardware entered in Settings. */
  setOverride(override: (probed: HardwareProfile) => HardwareProfile): void {
    this.override = override;
  }

  /** The llama-server whose device list sizes a Linux Intel card; probes again with it. */
  setLlamaServer(locate: NonNullable<HardwareProbeOptions['llamaServer']>): void {
    this.llamaServer = locate;
    this.forget();
  }

  /** Probes again on the next read, listing the llama-server's devices afresh, as after a driver or settings change. */
  forget(): void {
    this.pending = undefined;
    this.result = undefined;
    this.relist = true;
  }

  /**
   * After a model server is saved, on a Linux Intel card, whose VRAM only a llama-server listing gives: probes again
   * with the devices listed afresh when the saved server is a llama-server on this computer (`llamaServerSaved`), or
   * when the llama-server Desktop would list is no longer the one listed. The last result stays readable until replaced.
   */
  relistLlamaServer(llamaServerSaved: boolean, warn: (message: string) => void = () => undefined): void {
    void this.probed().then(async profile => {
      if (profile?.platform !== 'linux' || profile.memoryKind !== 'discrete' || profile.gpuVendor !== 'intel') return;
      if (!llamaServerSaved && !(await this.locatesAnother(warn))) return;
      this.pending = undefined;
      this.relist = true;
      void this.probed();
    });
  }

  /** Whether the llama-server Desktop would list now differs from the one listed; a check that cannot tell says yes. */
  private async locatesAnother(warn: (message: string) => void): Promise<boolean> {
    const locate = this.llamaServer;
    if (!locate) return false;
    try {
      const outcome = await withTimeout(
        locate().then(found => ({ found })),
        this.locateTimeoutMs
      );
      if (!outcome) throw new Error('the lookup timed out');
      const now = outcome.found ? await this.identify(outcome.found.path) : null;
      return now !== this.listedBinary;
    } catch (error) {
      warn(
        `MODEL SERVERS: could not tell which llama-server is in use, so listing its devices again: ${String(error)}`
      );
      return true;
    }
  }

  /** The probe with any override applied; null after a failed probe, which is tried again a minute later. */
  async profile(): Promise<HardwareProfile | null> {
    const probed = await this.probed();
    return probed && this.override(probed);
  }

  /** What the probe found, before any override. */
  probed(): Promise<HardwareProfile | null> {
    if (this.result === null && this.now() >= this.retryAt) this.pending = undefined;
    if (this.pending) return this.pending;
    const locate = this.llamaServer;
    let located: string | null | undefined;
    const options: HardwareProbeOptions = {
      ...(locate
        ? {
            llamaServer: async () => {
              const found = await locate();
              located = found ? await this.identify(found.path).catch(() => undefined) : null;
              return found;
            },
          }
        : {}),
      ...(this.relist ? { llamaServerMaxAgeMs: 0 } : {}),
    };
    this.relist = false;
    const previous = this.result;
    const pending: Promise<HardwareProfile | null> = this.probe(options).then(
      profile => {
        if (this.pending === pending) {
          this.result = profile;
          this.listedBinary = located;
        }
        return profile;
      },
      () => {
        // Superseded: hand a caller still awaiting this probe the newer one rather than a null that reads as failed.
        if (this.pending !== pending) return this.pending ?? previous ?? null;
        if (previous) return previous;
        this.retryAt = this.now() + RETRY_AFTER_MS;
        return (this.result = null);
      }
    );
    this.pending = pending;
    return pending;
  }

  /** Undefined while the probe has not finished. */
  known(): HardwareProfile | null | undefined {
    return this.result && this.override(this.result);
  }
}

export const localHardware = new HardwareProbe();

/** A saved llama-server that Desktop would launch on this computer, the kind localLlamaServer picks from. */
function launchesLocalLlamaServer(view: ModelServerView): boolean {
  return view.launch?.runtime === 'llama-server' && view.launch.owner !== 'remote';
}

/** The ModelServerRegistry.onServerSaved listener that has `hardware` list the llama-server's devices afresh. */
export function relistAfterSave(
  hardware: HardwareProbe,
  views: () => Promise<ModelServerView[]>,
  logger: { warn(message: string): void }
): (id: string) => void {
  return id => {
    const warn = (message: string) => logger.warn(message);
    void views().then(
      saved =>
        hardware.relistLlamaServer(
          saved.some(view => view.id === id && launchesLocalLlamaServer(view)),
          warn
        ),
      error => {
        // Unknown what was saved, so list again, as a failed check does.
        warn(
          `MODEL SERVERS: could not read the saved servers after a save, so listing the llama-server's devices again: ${String(error)}`
        );
        hardware.relistLlamaServer(true, warn);
      }
    );
  };
}

/** The llama-server Desktop would launch on this computer: a configured binary, else the first on the user's PATH. */
export function localLlamaServer(deps: {
  views(): Promise<ModelServerView[]>;
  onPath(): Promise<string | null>;
}): () => Promise<LlamaServerLocation | null> {
  return async () => {
    const launch = (await deps.views())
      .filter(launchesLocalLlamaServer)
      .map(view => view.launch)
      .find(view => view?.settings.binaryPath);
    const path = launch?.settings.binaryPath ?? (await deps.onPath());
    return path ? { path } : null;
  };
}

export interface LocalContextSizingDeps {
  setting(): Promise<LocalContextSetting>;
  hardware?: HardwareProbe;
  /** `/api/show` with verbose on: model_info with every per-layer array. */
  showVerbose?(model: string): Promise<{ model_info?: Record<string, unknown> | null; tensors?: unknown }>;
  /** The projector part of a model's size from its `/api/show` Modelfile; 0 when none or unknown. */
  projectorBytes?(modelfile: string): Promise<number>;
  /** The curated list's projector sizes by digest, for a projector blob this computer cannot read. */
  pinnedProjectors?(): ReadonlyMap<string, number>;
  /** The OLLAMA_KV_CACHE_TYPE this computer's Ollama runs with (see ModelServerRegistry.kvCacheType); undefined is f16. */
  kvCacheType?(): QuantizedKvCacheType | undefined;
  /** This computer's Ollama's OLLAMA_FLASH_ATTENTION when known (see ModelServerRegistry.flashAttention); undefined is auto. */
  flashAttention?(): FlashAttention | undefined;
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

interface ProjectorEntry {
  digest: string | undefined;
  bytes: number;
  pending?: Promise<number>;
}

/**
 * A model's shape from the `/api/show` OllamaLocal made (verbose only when per-layer arrays are missing),
 * kept per digest until Settings change. A failed verbose show is retried after a growing pause.
 */
export function localContextSizing({
  setting,
  hardware = localHardware,
  showVerbose = verboseShow,
  pinnedProjectors,
  projectorBytes = modelfile =>
    installedProjectorBytes(modelBlobsOf(modelfile), { pinned: pinnedProjectors?.(), onThisComputer: true }),
  kvCacheType = () => undefined,
  flashAttention = () => undefined,
  now = Date.now,
}: LocalContextSizingDeps): LocalContextSizing {
  const arches = new Map<string, ArchEntry>();
  const projectors = new Map<string, ProjectorEntry>();

  const projectorFor = (facts: LocalModelFacts): ProjectorEntry => {
    const known = projectors.get(facts.name);
    if (known && known.digest === facts.digest) return known;
    if (facts.modelfile === undefined) return { digest: facts.digest, bytes: 0 };
    const entry: ProjectorEntry = { digest: facts.digest, bytes: 0 };
    entry.pending = projectorBytes(facts.modelfile).then(
      bytes => (entry.bytes = bytes),
      () => 0
    );
    projectors.set(facts.name, entry);
    return entry;
  };

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

  const footprintOf = (
    facts: LocalModelFacts,
    arch: ModelArch | null,
    projector: number,
    machine: HardwareProfile | null
  ): LocalModelFootprint => ({
    arch,
    weightsBytes: facts.sizeBytes ?? null,
    projectorBytes: projector,
    hardware: machine,
    kvCacheType: kvCacheType(),
    flashAttention: flashAttention(),
  });

  return {
    setting,
    kvCacheType,
    async footprint(facts): Promise<LocalModelFootprint> {
      const entry = entryFor(facts);
      const projector = projectorFor(facts);
      const [arch, bytes, machine] = await Promise.all([
        entry.pending ?? entry.arch,
        projector.pending ?? projector.bytes,
        hardware.profile(),
      ]);
      return footprintOf(facts, arch, bytes, machine);
    },
    cachedFootprint(facts): LocalModelFootprint {
      void hardware.profile();
      return footprintOf(facts, entryFor(facts).arch, projectorFor(facts).bytes, hardware.known() ?? null);
    },
    forget() {
      arches.clear();
      projectors.clear();
    },
  };
}

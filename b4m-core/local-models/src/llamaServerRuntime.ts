import { realpath, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { LlamaServerVersionError, LocalRuntimeError, ModelIncompleteError, ModelNotFoundError } from './errors';
import { GgufModelStore, type StoredGgufModel } from './ggufStore';
import { HuggingFaceHub, findHubBuild, hubBuildTag, isHubRepoId } from './huggingface';
import {
  LLAMA_SERVER_FLASH_ATTN_VALUE_BUILD,
  findLlamaServer,
  flashAttentionArgs,
  startLlamaServer,
  type LlamaServerBinary,
  type LlamaServerExit,
  type LlamaServerProcess,
  type LlamaServerTuning,
} from './llamaServer';
import type {
  FetchLike,
  InstalledModel,
  LoadedModel,
  LocalRuntime,
  ModelInspection,
  PullOptions,
  RuntimeHealth,
} from './types';

export const LLAMA_SERVER_RUNTIME_ID = 'llama-server';
/** The quant `pull` takes for a ref without one, as Ollama does for `hf.co/<repo>`. */
export const DEFAULT_LLAMA_SERVER_PULL_QUANT = 'Q4_K_M';

const noop = () => undefined;
const HUB_REF_RE = /^(?:(?:hf|huggingface)\.co\/)?([^:]+)(?::([A-Za-z0-9_.-]+))?$/i;

export interface LlamaServerRuntimeOptions extends LlamaServerTuning {
  binaryPath: string;
  /** Placed before llama-server's own arguments, for a `binaryPath` that is a launcher. */
  binaryArgs?: readonly string[];
  /** Directory of GGUF files the caller owns; see `GgufModelStore`. */
  modelsDir: string;
  /** Where `pull` reads builds from and downloads them; default the public Hub, without a token. */
  hub?: Pick<HuggingFaceHub, 'getModel' | 'download'>;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
  onLog?: (model: string, line: string) => void;
}

export interface StartModelOptions extends LlamaServerTuning {
  /** Rejects this call; the shared start is cancelled only once every caller waiting on it has aborted. */
  signal?: AbortSignal;
  onExit?: (exit: LlamaServerExit) => void;
}

interface StartingEntry {
  controller: AbortController;
  /** Set once the server is ready. */
  server: LlamaServerProcess | null;
  sizeBytes: number | null;
  /** Callers still waiting for the start. */
  waiting: number;
  exitListeners: ((exit: LlamaServerExit) => void)[];
  /** Set by `stop()`; a `start()` meanwhile waits for it and starts a fresh server. */
  stopping: Promise<void> | null;
}

interface ServerEntry extends StartingEntry {
  pending: Promise<LlamaServerProcess>;
}

function installed(stored: StoredGgufModel): InstalledModel {
  return {
    name: stored.name,
    sizeBytes: stored.sizeBytes,
    quantization: stored.quantization,
    family: stored.family,
    parameterSize: stored.parameterSize,
    modifiedAt: stored.modifiedAt,
    capabilities: stored.capabilities,
  };
}

/** `hf.co/<repo>:<quant>`, `hf.co/<repo>` or `<repo>:<quant>`; `latest` and no tag mean the default quant. */
export function parseLlamaServerPullRef(ref: string): { repo: string; quant: string } {
  const match = HUB_REF_RE.exec(ref.trim());
  const repo = match?.[1];
  if (!repo || !isHubRepoId(repo))
    throw new LocalRuntimeError(`${JSON.stringify(ref)} is not a Hugging Face model ref`, LLAMA_SERVER_RUNTIME_ID);
  const tag = match[2];
  return { repo, quant: !tag || tag.toLowerCase() === 'latest' ? DEFAULT_LLAMA_SERVER_PULL_QUANT : tag };
}

/**
 * llama-server as a `LocalRuntime`: a binary, a models directory, and at most one server per model, each reached at
 * its own `baseUrl` with its `apiKey`.
 */
export class LlamaServerRuntime implements LocalRuntime {
  readonly id = LLAMA_SERVER_RUNTIME_ID;
  readonly kind = 'llama-server' as const;
  /** The models directory as a `file:` URL; each server has its own `http://127.0.0.1:<port>` `baseUrl`. */
  readonly baseUrl: string;
  readonly capabilities = { canPull: true, canRemove: true, canInspect: false, reportsLoaded: true } as const;
  readonly binaryPath: string;
  readonly store: GgufModelStore;
  readonly #options: LlamaServerRuntimeOptions;
  readonly #servers = new Map<string, ServerEntry>();
  #hub: Pick<HuggingFaceHub, 'getModel' | 'download'> | undefined;
  #found: { key: string; binary: LlamaServerBinary } | null = null;

  constructor(options: LlamaServerRuntimeOptions) {
    this.binaryPath = options.binaryPath;
    this.store = new GgufModelStore({ dir: options.modelsDir });
    this.baseUrl = pathToFileURL(options.modelsDir).href;
    this.#options = options;
    this.#hub = options.hub;
  }

  /** Whether the binary runs and is new enough; a healthy answer is kept until the binary file changes. Never throws. */
  async health(): Promise<RuntimeHealth> {
    try {
      const { version } = await this.#binary();
      return { ok: true, version, error: null };
    } catch (error) {
      return { ok: false, version: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The binary's version and build, probed once until the binary file changes; start needs the build for its flags. */
  async #binary(): Promise<LlamaServerBinary> {
    // Keyed on what actually runs: a symlink swapped to another build, or a changed script in binaryArgs.
    const identify = (path: string) =>
      realpath(path).then(real => stat(real).then(info => `${real}:${info.mtimeMs}:${info.size}`));
    const key = await identify(this.binaryPath).then(
      async binary => {
        const args = this.#options.binaryArgs ?? [];
        return JSON.stringify([binary, ...(await Promise.all(args.map(arg => identify(arg).catch(() => arg))))]);
      },
      () => null
    );
    if (key !== null && this.#found?.key === key) return this.#found.binary;
    const binary = await findLlamaServer({
      path: this.binaryPath,
      binaryArgs: this.#options.binaryArgs,
      env: this.#options.env,
    });
    if (!binary) throw new LocalRuntimeError(`llama-server at ${this.binaryPath} could not be checked`, this.id);
    this.#found = key === null ? null : { key, binary };
    return binary;
  }

  async list(): Promise<InstalledModel[]> {
    return (await this.store.list()).filter(model => model.complete && !model.projector).map(installed);
  }

  async inspect(model: string): Promise<ModelInspection> {
    const found = (await this.list()).find(entry => entry.name === model);
    if (!found) throw new ModelNotFoundError(this.id, model);
    return { model: found, arch: null, tensorStats: null };
  }

  /**
   * Downloads the build of `ref` (see `parseLlamaServerPullRef`) its tag names, resolved as `findHubBuild` does. Only
   * this explicit call downloads. The model then lists as `<repo>/<path in repo>`.
   */
  async pull(ref: string, opts: PullOptions = {}): Promise<void> {
    const { repo, quant } = parseLlamaServerPullRef(ref);
    this.#hub ??= new HuggingFaceHub({ fetch: this.#options.fetch });
    const detail = await this.#hub.getModel(repo, { signal: opts.signal });
    const build = findHubBuild(detail.builds, quant);
    if (!build) {
      const tags = detail.builds.map(hubBuildTag);
      throw new ModelNotFoundError(this.id, ref, {
        cause: new Error(`${repo} offers ${tags.length > 0 ? tags.join(', ') : 'no GGUF builds'}`),
      });
    }
    if (!build.complete) throw new ModelIncompleteError(this.id, ref, []);
    await this.store.download(this.#hub, { repo: detail.id, revision: detail.revision, files: build.files }, opts);
  }

  /** Stops the model's server, if any, then deletes its files or its partial download. */
  async remove(model: string): Promise<void> {
    await this.stop(model);
    await this.store.remove(model);
  }

  /** Running servers. `vramBytes` is 0: llama-server does not report its device memory. */
  async loaded(): Promise<LoadedModel[]> {
    return [...this.#servers.entries()].flatMap(([name, entry]) =>
      entry.server?.running
        ? [
            {
              name,
              sizeBytes: entry.sizeBytes ?? 0,
              vramBytes: 0,
              contextLength: entry.server.contextSize || null,
              expiresAt: null,
            },
          ]
        : []
    );
  }

  /**
   * Starts a server for `model` (a name from `list()`), or joins the one already running or starting. Tuning is
   * per call over the runtime defaults, and the first caller's applies.
   */
  start(model: string, options: StartModelOptions = {}): Promise<LlamaServerProcess> {
    let entry = this.#servers.get(model);
    if (!entry || entry.stopping || (!entry.server && entry.controller.signal.aborted)) {
      // The entry replaced may still be stopping its server, or a cancelled one; never run two for one model.
      const before = entry && (entry.stopping ?? entry.pending.then(noop, noop));
      const starting: StartingEntry = {
        controller: new AbortController(),
        server: null,
        sizeBytes: null,
        waiting: 0,
        exitListeners: [],
        stopping: null,
      };
      const pending = before
        ? before.then(() => this.#start(model, options, starting))
        : this.#start(model, options, starting);
      const created: ServerEntry = Object.assign(starting, { pending });
      this.#servers.set(model, created);
      const forget = () => {
        if (this.#servers.get(model) === created) this.#servers.delete(model);
      };
      created.pending.then(server => server.exited.then(forget), forget);
      entry = created;
    }
    return this.#join(entry, options);
  }

  #join(entry: ServerEntry, { signal, onExit }: StartModelOptions): Promise<LlamaServerProcess> {
    if (onExit) entry.exitListeners.push(onExit);
    const leave = () => {
      const index = onExit ? entry.exitListeners.indexOf(onExit) : -1;
      if (index >= 0) entry.exitListeners.splice(index, 1);
    };
    if (entry.server) return entry.pending;
    if (signal?.aborted) {
      leave();
      if (entry.waiting === 0) entry.controller.abort(signal.reason);
      return Promise.reject(signal.reason);
    }
    entry.waiting++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = () => {
        if (settled) return false;
        settled = true;
        entry.waiting--;
        signal?.removeEventListener('abort', onAbort);
        return true;
      };
      const onAbort = () => {
        if (!settle()) return;
        leave();
        if (entry.waiting === 0 && !entry.server) entry.controller.abort(signal?.reason);
        reject(signal?.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      entry.pending.then(
        server => settle() && resolve(server),
        (error: unknown) => settle() && reject(error)
      );
    });
  }

  /** Servers that finished starting and are still running; one still loading is not listed. */
  async running(): Promise<LlamaServerProcess[]> {
    return [...this.#servers.values()].flatMap(entry => (entry.server?.running ? [entry.server] : []));
  }

  /** Stops the model's server; one still loading is cancelled, and its `start` rejects. */
  async stop(model: string): Promise<void> {
    const entry = this.#servers.get(model);
    if (!entry) return;
    entry.stopping ??= (async () => {
      if (!entry.server)
        entry.controller.abort(new LocalRuntimeError(`${model} was stopped before it was ready`, this.id));
      const server = await entry.pending.catch(() => null);
      await server?.stop();
    })();
    await entry.stopping;
  }

  /**
   * Stops every server. Servers run in their own process group, so Ctrl-C does not reach them: call this from the
   * host's SIGINT and SIGTERM handlers. Only a normal `exit` kills them otherwise.
   */
  async stopAll(): Promise<void> {
    await Promise.all([...this.#servers.keys()].map(model => this.stop(model)));
  }

  async #start(model: string, options: StartModelOptions, entry: StartingEntry): Promise<LlamaServerProcess> {
    const stored = await this.store.get(model);
    if (stored.projector) throw new LocalRuntimeError(`${model} is a vision projector, not a model`, this.id);
    if (!stored.complete) throw new ModelIncompleteError(this.id, model, stored.missingShards);
    entry.sizeBytes = stored.sizeBytes;
    const defaults = this.#options;
    const tuning = {
      flashAttention: options.flashAttention ?? defaults.flashAttention,
      extraArgs: options.extraArgs ?? defaults.extraArgs,
    };
    const build = await this.#binary().then(
      found => found.build,
      (error: unknown) => {
        // A build that prints no number (built without git) still runs when no flag depends on the build.
        const unnumbered = error instanceof LlamaServerVersionError && !error.found;
        if (unnumbered && flashAttentionArgs(tuning, LLAMA_SERVER_FLASH_ATTN_VALUE_BUILD).length === 0)
          return undefined;
        throw error;
      }
    );
    entry.controller.signal.throwIfAborted();
    const onLog = defaults.onLog;
    const server = await startLlamaServer({
      binaryPath: this.binaryPath,
      binaryArgs: defaults.binaryArgs,
      build,
      ...tuning,
      modelPath: stored.path,
      alias: model,
      contextSize: options.contextSize ?? defaults.contextSize,
      threads: options.threads ?? defaults.threads,
      gpuLayers: options.gpuLayers ?? defaults.gpuLayers,
      startTimeoutMs: defaults.startTimeoutMs,
      stopTimeoutMs: defaults.stopTimeoutMs,
      fetch: defaults.fetch,
      env: defaults.env,
      signal: entry.controller.signal,
      onExit: exit => {
        for (const listener of [...entry.exitListeners]) {
          try {
            listener(exit);
          } catch {
            // One caller's callback must not keep the others from hearing of the exit.
          }
        }
      },
      onLog: onLog && (line => onLog(model, line)),
    });
    entry.server = server;
    return server;
  }
}

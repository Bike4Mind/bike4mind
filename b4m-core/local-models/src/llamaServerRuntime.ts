import { pathToFileURL } from 'node:url';
import { LocalRuntimeError, ModelNotFoundError } from './errors';
import { GgufModelStore, type StoredGgufModel } from './ggufStore';
import { HuggingFaceHub, isHubRepoId } from './huggingface';
import {
  findLlamaServer,
  startLlamaServer,
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
  signal?: AbortSignal;
  onExit?: (exit: LlamaServerExit) => void;
}

interface ServerEntry {
  pending: Promise<LlamaServerProcess>;
  controller: AbortController;
  /** Set once the server is ready. */
  server: LlamaServerProcess | null;
  sizeBytes: number | null;
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
 * llama-server as a managed runtime: a binary, a models directory, and at most one server per model. Chat goes to
 * each server's OpenAI-compatible `baseUrl` with its `apiKey`. As a `LocalRuntime`, `list` shows the complete,
 * servable models, `pull` downloads a Hugging Face build, `remove` stops and deletes one, and `loaded` lists the
 * running servers.
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

  constructor(options: LlamaServerRuntimeOptions) {
    this.binaryPath = options.binaryPath;
    this.store = new GgufModelStore({ dir: options.modelsDir });
    this.baseUrl = pathToFileURL(options.modelsDir).href;
    this.#options = options;
    this.#hub = options.hub;
  }

  /** Whether the binary runs and is new enough. Never throws. */
  async health(): Promise<RuntimeHealth> {
    try {
      const found = await findLlamaServer({
        path: this.binaryPath,
        binaryArgs: this.#options.binaryArgs,
        env: this.#options.env,
      });
      return { ok: true, version: found?.version ?? null, error: null };
    } catch (error) {
      return { ok: false, version: null, error: error instanceof Error ? error.message : String(error) };
    }
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
   * Downloads the build of `ref` (see `parseLlamaServerPullRef`) whose quant label matches, ignoring case, into the
   * models directory. Only this explicit call downloads. The model then lists under its file name.
   */
  async pull(ref: string, opts: PullOptions = {}): Promise<void> {
    const { repo, quant } = parseLlamaServerPullRef(ref);
    this.#hub ??= new HuggingFaceHub({ fetch: this.#options.fetch });
    const detail = await this.#hub.getModel(repo, { signal: opts.signal });
    const build = detail.builds.find(entry => entry.quant?.toUpperCase() === quant.toUpperCase());
    if (!build) {
      const quants = [...new Set(detail.builds.flatMap(entry => (entry.quant ? [entry.quant] : [])))];
      throw new ModelNotFoundError(this.id, ref, {
        cause: new Error(`${repo} offers ${quants.length > 0 ? quants.join(', ') : 'no labelled quants'}`),
      });
    }
    if (!build.complete) throw new LocalRuntimeError(`${ref} is missing shards on the Hub`, this.id);
    await this.store.download(this.#hub, { files: build.files }, opts);
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
   * Starts a server for `model` (a name from `list()`), or returns the one already running or starting it.
   * Tuning is per call over the runtime defaults and applies only to a new server.
   */
  start(model: string, options: StartModelOptions = {}): Promise<LlamaServerProcess> {
    const existing = this.#servers.get(model);
    if (existing) return existing.pending;
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    // `pending` is assigned on the next line; #start fills in `server` and `sizeBytes`.
    const entry = { controller, server: null, sizeBytes: null } as Partial<ServerEntry> as ServerEntry;
    entry.pending = this.#start(model, options, signal, entry);
    this.#servers.set(model, entry);
    const forget = () => {
      if (this.#servers.get(model) === entry) this.#servers.delete(model);
    };
    entry.pending.then(server => server.exited.then(forget), forget);
    return entry.pending;
  }

  /** Servers that finished starting and are still running; one still loading is not listed. */
  async running(): Promise<LlamaServerProcess[]> {
    return [...this.#servers.values()].flatMap(entry => (entry.server?.running ? [entry.server] : []));
  }

  /** Stops the model's server; one still loading is cancelled, and its `start` rejects. */
  async stop(model: string): Promise<void> {
    const entry = this.#servers.get(model);
    if (!entry) return;
    if (!entry.server)
      entry.controller.abort(new LocalRuntimeError(`${model} was stopped before it was ready`, this.id));
    const server = await entry.pending.catch(() => null);
    await server?.stop();
  }

  /**
   * Stops every server. Call it from the host's own SIGINT and SIGTERM handlers: only a normal `exit` kills the
   * servers on its own, so a host killed by a signal it does not handle leaves them running.
   */
  async stopAll(): Promise<void> {
    await Promise.all([...this.#servers.keys()].map(model => this.stop(model)));
  }

  async #start(
    model: string,
    options: StartModelOptions,
    signal: AbortSignal,
    entry: ServerEntry
  ): Promise<LlamaServerProcess> {
    const stored = await this.store.get(model);
    if (stored.projector) throw new LocalRuntimeError(`${model} is a vision projector, not a model`, this.id);
    if (!stored.complete) throw new LocalRuntimeError(`${model} is missing shards`, this.id);
    entry.sizeBytes = stored.sizeBytes;
    const defaults = this.#options;
    const onLog = defaults.onLog;
    const server = await startLlamaServer({
      binaryPath: this.binaryPath,
      binaryArgs: defaults.binaryArgs,
      modelPath: stored.path,
      alias: model,
      contextSize: options.contextSize ?? defaults.contextSize,
      threads: options.threads ?? defaults.threads,
      gpuLayers: options.gpuLayers ?? defaults.gpuLayers,
      extraArgs: options.extraArgs ?? defaults.extraArgs,
      startTimeoutMs: defaults.startTimeoutMs,
      stopTimeoutMs: defaults.stopTimeoutMs,
      fetch: defaults.fetch,
      env: defaults.env,
      signal,
      onExit: options.onExit,
      onLog: onLog && (line => onLog(model, line)),
    });
    entry.server = server;
    return server;
  }
}

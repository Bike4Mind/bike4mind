import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, constants, stat } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import {
  LlamaServerExitError,
  LlamaServerVersionError,
  LocalRuntimeError,
  ModelNotFoundError,
  RuntimeProtocolError,
} from './errors';
import { storageError } from './fileLock';
import { requestJson, type HttpClient } from './http';
import { OpenAICompatibleRuntime } from './openaiCompatible';
import type { FetchLike } from './types';

export const DEFAULT_LLAMA_SERVER_CONTEXT_SIZE = 4096;
export const DEFAULT_LLAMA_SERVER_START_TIMEOUT_MS = 120_000;
export const DEFAULT_LLAMA_SERVER_STOP_TIMEOUT_MS = 5_000;
/** First llama.cpp release with `--offline`; `--jinja`, `--no-webui` and `LLAMA_API_KEY` are older. */
export const MIN_LLAMA_SERVER_BUILD = 5501;

const RUNTIME_ID = 'llama-server';
const LOOPBACK = '127.0.0.1';
const VERSION_TIMEOUT_MS = 10_000;
const HEALTH_POLL_MS = 200;
const HEALTH_REQUEST_TIMEOUT_MS = 1_000;
const LOG_LINES = 200;
const PORT_ATTEMPTS = 3;
const MAX_MESSAGE_LINE = 300;
const FLAG_RE = /^--?[a-zA-Z]/;

/**
 * Flags `extraArgs` may pass: performance, memory, sampling defaults and chat-template tuning. Anything else could
 * expose the server (host, port, key, TLS, UI, MCP proxy, API prefix, static paths), fetch over the network, write
 * files, or override a flag this module sets, so it is refused. Context size, threads and GPU layers have options.
 */
const TUNING_FLAGS = new Set(
  [
    '-b --batch-size -ub --ubatch-size -tb --threads-batch -fa --flash-attn',
    '-ctk --cache-type-k -ctv --cache-type-v --mlock --mmap --no-mmap -lm --load-mode',
    '-np --parallel -cb --cont-batching -nocb --no-cont-batching -kvu --kv-unified -no-kvu --no-kv-unified',
    '-kvo --kv-offload -nkvo --no-kv-offload -sm --split-mode -ts --tensor-split -mg --main-gpu -dev --device',
    '-fit --fit -fitt --fit-target -fitc --fit-ctx -cmoe --cpu-moe -ncmoe --n-cpu-moe',
    '--rope-scaling --rope-scale --rope-freq-base --rope-freq-scale --yarn-orig-ctx --yarn-ext-factor',
    '--yarn-attn-factor --yarn-beta-slow --yarn-beta-fast',
    '--temp --temperature --top-k --top-p --min-p --repeat-last-n --repeat-penalty --presence-penalty',
    '--frequency-penalty -n --predict --n-predict',
    '-rea --reasoning --reasoning-format --reasoning-budget',
    '--chat-template --chat-template-file --chat-template-kwargs',
    '-mm --mmproj --no-mmproj --mmproj-offload --no-mmproj-offload',
    '--cache-reuse -cram --cache-ram --warmup --no-warmup --swa-full --context-shift --no-context-shift',
    '--embedding --embeddings --pooling --no-slots',
  ].flatMap(line => line.split(' '))
);

const healthSchema = z.object({ status: z.string() });

export interface LlamaServerBinary {
  path: string;
  /** The `--version` line after `version:`, e.g. `0.7.0-dev (build 11912, commit 961c376a2)`. */
  version: string;
  /** The llama.cpp release number (`b11912` is 11912); at least `MIN_LLAMA_SERVER_BUILD`. */
  build: number;
}

export interface FindLlamaServerOptions {
  /** A configured or bundled binary. When set, PATH is not searched, and a binary that cannot run throws. */
  path?: string;
  /** With `path`: placed before `--version`, for a binary that is a launcher. */
  binaryArgs?: readonly string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

/**
 * Finds a llama-server binary that runs and is at least `MIN_LLAMA_SERVER_BUILD`: `options.path` if given, else
 * the first such `llama-server` on PATH. Never downloads one. A binary that is too old, or whose version names no
 * build, throws `LlamaServerVersionError`; on PATH that happens only when no entry qualifies. Null when PATH has
 * no llama-server at all.
 */
export async function findLlamaServer(options: FindLlamaServerOptions = {}): Promise<LlamaServerBinary | null> {
  const timeoutMs = options.timeoutMs ?? VERSION_TIMEOUT_MS;
  const env = options.env ?? process.env;
  if (options.path !== undefined) {
    const found = await probeBinary(resolve(options.path), env, timeoutMs, true, options.binaryArgs);
    return checkBuild(found as NonNullable<typeof found>);
  }
  const windows = (options.platform ?? process.platform) === 'win32';
  const dirs = (env.PATH ?? env.Path ?? '').split(windows ? ';' : ':');
  let tooOld: LlamaServerVersionError | null = null;
  for (const dir of dirs) {
    // A relative entry would resolve against this process's working directory.
    if (!dir || !isAbsolute(dir)) continue;
    const found = await probeBinary(join(dir, windows ? 'llama-server.exe' : 'llama-server'), env, timeoutMs, false);
    if (!found) continue;
    try {
      return checkBuild(found);
    } catch (error) {
      tooOld ??= error as LlamaServerVersionError;
    }
  }
  if (tooOld) throw tooOld;
  return null;
}

function checkBuild(found: { path: string; version: string; build: number | null }): LlamaServerBinary {
  if (found.build === null || found.build < MIN_LLAMA_SERVER_BUILD)
    throw new LlamaServerVersionError(found.path, found.build, MIN_LLAMA_SERVER_BUILD);
  return { path: found.path, version: found.version, build: found.build };
}

async function probeBinary(
  path: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  strict: boolean,
  binaryArgs: readonly string[] = []
): Promise<{ path: string; version: string; build: number | null } | null> {
  const fail = (reason: string) => {
    if (strict) throw new LocalRuntimeError(`llama-server at ${path} ${reason}`, RUNTIME_ID);
    return null;
  };
  try {
    await access(path, constants.X_OK);
  } catch {
    return fail('is missing or not executable');
  }
  const output = await new Promise<{ text: string; error: Error | null }>(done => {
    execFile(
      path,
      [...binaryArgs, '--version'],
      { timeout: timeoutMs, windowsHide: true, env: childEnv(env) },
      (error, stdout, stderr) => done({ text: `${stdout}\n${stderr}`, error })
    );
  });
  const version = /^version:\s*(.+?)\s*$/m.exec(output.text)?.[1];
  if (!version) return fail(output.error ? `could not run: ${output.error.message}` : 'is not llama-server');
  const build = /\bbuild (\d+)/.exec(version)?.[1] ?? /^(\d+) \(/.exec(version)?.[1];
  return { path, version, build: build ? Number(build) : null };
}

/** The parent's environment without llama.cpp settings or Hugging Face tokens, which would override our flags. */
function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !/^LLAMA_/i.test(name) && !/^(HF_TOKEN|HUGGING_FACE_HUB_TOKEN)$/i.test(name))
  );
}

export interface LlamaServerTuning {
  /** Context size in tokens; default `DEFAULT_LLAMA_SERVER_CONTEXT_SIZE`. 0 takes the model's full training context. */
  contextSize?: number;
  /** Generation threads; llama.cpp picks the physical core count when unset. */
  threads?: number;
  /** Layers offloaded to the GPU; llama.cpp's default when unset. */
  gpuLayers?: number;
  /**
   * Appended last. Only tuning flags are accepted (batch sizes, flash attention, KV cache types, memory mapping,
   * parallel slots, GPU split and fit, MoE offload, RoPE and YaRN, sampling defaults, reasoning, chat template,
   * projector, cache reuse, warmup, embeddings), short or long, each value as its own argument (llama-server does
   * not parse `--flag=value`). Any other flag throws, as does a `--flag=value` token.
   */
  extraArgs?: readonly string[];
}

export interface StartLlamaServerOptions extends LlamaServerTuning {
  binaryPath: string;
  /** Placed before llama-server's own arguments, for a `binaryPath` that is a launcher. */
  binaryArgs?: readonly string[];
  modelPath: string;
  /** Model id the server answers to on `/v1`; default the file name. No commas: llama-server splits on them. */
  alias?: string;
  /** A fixed loopback port. Default: a free port, replaced with another when something takes it first. */
  port?: number;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  signal?: AbortSignal;
  onLog?: (line: string) => void;
  /** Called once when the process exits after a successful start, whether stopped or crashed. */
  onExit?: (exit: LlamaServerExit) => void;
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
}

export interface LlamaServerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** True when `stop()` ended it; false for a crash or an outside kill. */
  stopped: boolean;
}

export interface LlamaServerProcess {
  readonly pid: number;
  /** `http://127.0.0.1:<port>`; the OpenAI API is under `/v1`. */
  readonly baseUrl: string;
  readonly port: number;
  /** Per-process key, required on every request except `/health`. */
  readonly apiKey: string;
  /** Model id to send in requests. */
  readonly model: string;
  readonly modelPath: string;
  /** The `--ctx-size` it runs with; 0 is the model's training context. */
  readonly contextSize: number;
  /** Resolves when the process exits for any reason. */
  readonly exited: Promise<LlamaServerExit>;
  readonly running: boolean;
  /** The last lines the process printed. */
  log(): string[];
  /** Sends SIGTERM, then SIGKILL after `stopTimeoutMs`; resolves once the process is gone. */
  stop(): Promise<LlamaServerExit>;
}

const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

// An 'exit' listener may only do synchronous work; kill() is synchronous.
function killLiveChildren(): void {
  for (const child of liveChildren) child.kill('SIGKILL');
}

function track(child: ChildProcess): void {
  if (!exitHookInstalled) {
    process.on('exit', killLiveChildren);
    exitHookInstalled = true;
  }
  liveChildren.add(child);
  child.once('exit', () => liveChildren.delete(child));
  // A child that never spawned emits 'error' and no 'exit'.
  child.once('error', () => {
    if (child.pid === undefined) liveChildren.delete(child);
  });
}

/** For tests: whether the parent-exit hook still holds a process. */
export function trackedLlamaServerCount(): number {
  return liveChildren.size;
}

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.unref();
    server.once('error', fail);
    server.listen(0, LOOPBACK, () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => done(port));
    });
  });
}

class ManagedLlamaServer implements LlamaServerProcess {
  readonly baseUrl: string;
  readonly #runtime: OpenAICompatibleRuntime;
  readonly exited: Promise<LlamaServerExit>;
  readonly client: HttpClient;
  exit: LlamaServerExit | null = null;
  spawnError: Error | null = null;
  onExit: ((exit: LlamaServerExit) => void) | undefined;
  readonly #lines: string[] = [];
  #stopping = false;

  constructor(
    readonly child: ChildProcess,
    readonly port: number,
    readonly apiKey: string,
    readonly model: string,
    readonly modelPath: string,
    readonly contextSize: number,
    private readonly stopTimeoutMs: number,
    fetchImpl: FetchLike,
    onLog: ((line: string) => void) | undefined
  ) {
    this.baseUrl = `http://${LOOPBACK}:${port}`;
    this.#runtime = new OpenAICompatibleRuntime({
      baseUrl: this.baseUrl,
      apiKey,
      product: 'llama-server',
      fetch: fetchImpl,
    });
    this.client = { runtimeId: this.#runtime.id, baseUrl: this.baseUrl, fetch: fetchImpl };
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      createInterface({ input: stream, crlfDelay: Infinity }).on('line', line => {
        this.#lines.push(line);
        if (this.#lines.length > LOG_LINES) this.#lines.shift();
        try {
          onLog?.(line);
        } catch {
          // A throwing log callback must not take down the reader.
        }
      });
    }
    this.exited = new Promise(done => {
      const finish = (exit: LlamaServerExit) => {
        if (this.exit) return;
        this.exit = exit;
        done(exit);
        try {
          this.onExit?.(exit);
        } catch {
          // Same as onLog: the caller's callback cannot fail the process bookkeeping.
        }
      };
      child.once('exit', (code, signal) => finish({ code, signal, stopped: this.#stopping }));
      // `on`, not `once`: a later 'error' (a failed kill) with no listener would crash the host process.
      child.on('error', error => {
        if (child.pid !== undefined) return;
        this.spawnError = error;
        finish({ code: null, signal: null, stopped: false });
      });
    });
  }

  get pid(): number {
    return this.child.pid ?? -1;
  }

  get running(): boolean {
    return this.exit === null;
  }

  log(): string[] {
    return [...this.#lines];
  }

  /** Whether `/v1/models`, asked with this server's key, lists its alias. */
  async serves(): Promise<boolean> {
    const served = await this.#runtime.list().catch(() => []);
    return served.some(entry => entry.name === this.model);
  }

  async stop(): Promise<LlamaServerExit> {
    if (this.exit) return this.exit;
    this.#stopping = true;
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), this.stopTimeoutMs);
    try {
      return await this.exited;
    } finally {
      clearTimeout(timer);
    }
  }

  exitError(binaryPath: string): LlamaServerExitError {
    const lines = this.log();
    if (this.spawnError) {
      return new LlamaServerExitError(
        `could not run ${binaryPath}: ${this.spawnError.message}`,
        null,
        null,
        false,
        lines
      );
    }
    const { code, signal } = this.exit ?? { code: null, signal: null };
    const portInUse = lines.some(line => /couldn't bind|address already in use/i.test(line));
    const reason = portInUse
      ? `port ${this.port} is in use`
      : (lines.filter(line => /\b(E|error|failed)\b/i.test(line)).at(-1) ?? lines.at(-1) ?? 'no output');
    const how = signal ? `signal ${signal}` : `code ${code}`;
    return new LlamaServerExitError(
      `llama-server exited before it was ready (${how}): ${reason.trim().slice(0, MAX_MESSAGE_LINE)}`,
      code,
      signal,
      portInUse,
      lines
    );
  }
}

export function assertTuning(options: LlamaServerTuning): void {
  for (const arg of options.extraArgs ?? []) {
    if (!FLAG_RE.test(arg)) continue;
    const flag = arg.split('=')[0] as string;
    if (!TUNING_FLAGS.has(flag)) {
      throw new LocalRuntimeError(`extraArgs may not pass ${flag}; only tuning flags are accepted`, RUNTIME_ID);
    }
    if (flag !== arg) {
      throw new LocalRuntimeError(`llama-server takes the value of ${flag} as a separate argument`, RUNTIME_ID);
    }
  }
  const { contextSize, threads, gpuLayers } = options;
  if (contextSize !== undefined && !(Number.isInteger(contextSize) && contextSize >= 0))
    throw new LocalRuntimeError('contextSize must be a non-negative integer', RUNTIME_ID);
  if (threads !== undefined && !(Number.isInteger(threads) && threads > 0))
    throw new LocalRuntimeError('threads must be a positive integer', RUNTIME_ID);
  if (gpuLayers !== undefined && !(Number.isInteger(gpuLayers) && gpuLayers >= 0))
    throw new LocalRuntimeError('gpuLayers must be a non-negative integer', RUNTIME_ID);
}

function serverArgs(options: StartLlamaServerOptions, alias: string, port: number, contextSize: number): string[] {
  return [
    ...(options.binaryArgs ?? []),
    '--model',
    options.modelPath,
    '--alias',
    alias,
    '--host',
    LOOPBACK,
    '--port',
    String(port),
    '--ctx-size',
    String(contextSize),
    ...(options.threads === undefined ? [] : ['--threads', String(options.threads)]),
    ...(options.gpuLayers === undefined ? [] : ['--n-gpu-layers', String(options.gpuLayers)]),
    // Tool calls need the model's own chat template.
    '--jinja',
    '--no-webui',
    // No network: the product never downloads a model on its own.
    '--offline',
    ...(options.extraArgs ?? []),
  ];
}

function untilAborted(signal: AbortSignal | undefined): { promise: Promise<void>; dispose(): void } {
  let dispose = () => undefined as void;
  const promise = new Promise<void>(done => {
    if (!signal) return;
    if (signal.aborted) return done();
    const onAbort = () => done();
    signal.addEventListener('abort', onAbort, { once: true });
    dispose = () => signal.removeEventListener('abort', onAbort);
  });
  return { promise, dispose: () => dispose() };
}

const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms).unref());

/**
 * Starts llama-server for one GGUF file on a loopback port with a fresh API key, and resolves once `/health`
 * answers and `/v1/models` serves this model with that key. The key travels in the environment, not argv, so
 * other local users cannot read it from the process list. A process still running when this one exits is killed.
 * Aborting `signal` stops a server that is still loading and rejects with the signal's reason.
 */
export async function startLlamaServer(options: StartLlamaServerOptions): Promise<LlamaServerProcess> {
  options.signal?.throwIfAborted();
  assertTuning(options);
  const alias = options.alias ?? basename(options.modelPath);
  if (!alias || alias.includes(','))
    throw new LocalRuntimeError(`${JSON.stringify(alias)} cannot be a llama-server alias`, RUNTIME_ID);
  const file = await stat(options.modelPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw storageError(RUNTIME_ID, options.modelPath, error);
  });
  if (!file?.isFile()) throw new ModelNotFoundError(RUNTIME_ID, options.modelPath);
  for (let attempt = 1; ; attempt++) {
    const port = options.port ?? (await freePort());
    options.signal?.throwIfAborted();
    try {
      return await launch(options, alias, port);
    } catch (error) {
      const retry = error instanceof LlamaServerExitError && error.portInUse && options.port === undefined;
      if (retry && attempt < PORT_ATTEMPTS) continue;
      throw error;
    }
  }
}

async function launch(options: StartLlamaServerOptions, alias: string, port: number): Promise<LlamaServerProcess> {
  const apiKey = randomBytes(32).toString('base64url');
  const contextSize = options.contextSize ?? DEFAULT_LLAMA_SERVER_CONTEXT_SIZE;
  const child = spawn(options.binaryPath, serverArgs(options, alias, port, contextSize), {
    env: { ...childEnv(options.env ?? process.env), LLAMA_API_KEY: apiKey },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  track(child);
  const server = new ManagedLlamaServer(
    child,
    port,
    apiKey,
    alias,
    options.modelPath,
    contextSize,
    options.stopTimeoutMs ?? DEFAULT_LLAMA_SERVER_STOP_TIMEOUT_MS,
    options.fetch ?? fetch,
    options.onLog
  );
  const timeoutMs = options.startTimeoutMs ?? DEFAULT_LLAMA_SERVER_START_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const aborted = untilAborted(options.signal);
  try {
    while (true) {
      options.signal?.throwIfAborted();
      if (!server.running) throw server.exitError(options.binaryPath);
      if (Date.now() > deadline)
        throw new LocalRuntimeError(`llama-server did not become ready within ${timeoutMs}ms`, RUNTIME_ID);
      const healthy = await requestJson(server.client, '/health', healthSchema, {
        timeoutMs: HEALTH_REQUEST_TIMEOUT_MS,
        signal: options.signal,
      }).then(
        () => true,
        () => false
      );
      if (healthy) break;
      // 503 while the model loads, or refused before the socket is bound.
      await Promise.race([delay(HEALTH_POLL_MS), server.exited, aborted.promise]);
    }
    if (!(await server.serves())) {
      // Another server answered on this port; ours fails to bind and exits within moments.
      await Promise.race([delay(1_000), server.exited]);
      if (!server.running) throw server.exitError(options.binaryPath);
      throw new RuntimeProtocolError(`port ${port} answered, but not as the llama-server just started`, RUNTIME_ID);
    }
    options.signal?.throwIfAborted();
    server.onExit = options.onExit;
    return server;
  } catch (error) {
    await server.stop();
    options.signal?.throwIfAborted();
    throw error;
  } finally {
    aborted.dispose();
  }
}

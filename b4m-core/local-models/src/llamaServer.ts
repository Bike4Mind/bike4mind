import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, constants, readFile, readdir, readlink, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import {
  LlamaServerBinaryError,
  LlamaServerExitError,
  LlamaServerStartError,
  LlamaServerVersionError,
  LocalRuntimeError,
  ModelNotFoundError,
} from './errors';
import { storageError } from './fileLock';
import { requestJson, type HttpClient } from './http';
import { OpenAICompatibleRuntime } from './openaiCompatible';
import type { FetchLike } from './types';

/** Used when the caller passes no `contextSize`; callers such as Desktop pass one sized to the hardware. */
export const DEFAULT_LLAMA_SERVER_CONTEXT_SIZE = 16384;
export const DEFAULT_LLAMA_SERVER_STOP_TIMEOUT_MS = 5_000;
/** First llama.cpp release with `--offline`; `--jinja`, `--no-webui`, `--port 0` and `LLAMA_API_KEY` are older. */
export const MIN_LLAMA_SERVER_BUILD = 5501;

/**
 * The only flags `extraArgs` may pass: same values in b5501 and current builds (so not `--flash-attn`). Anything
 * else could expose the server, fetch over the network, write files, or override a flag this module sets.
 */
export const LLAMA_SERVER_TUNING_FLAGS: readonly string[] = [
  '-b --batch-size -ub --ubatch-size -tb --threads-batch',
  '-ctk --cache-type-k -ctv --cache-type-v -np --parallel -cb --cont-batching -nocb --no-cont-batching',
  '-nkvo --no-kv-offload -sm --split-mode -ts --tensor-split -mg --main-gpu -dev --device',
  '--rope-scaling --rope-scale --rope-freq-base --rope-freq-scale --yarn-orig-ctx --yarn-ext-factor',
  '--yarn-attn-factor --yarn-beta-slow --yarn-beta-fast',
  '--temp --top-k --top-p --min-p --repeat-last-n --repeat-penalty --presence-penalty --frequency-penalty',
  '-n --predict --n-predict --reasoning-format --reasoning-budget --chat-template --chat-template-file',
  '--mmproj --no-mmproj --no-mmproj-offload --cache-reuse --no-warmup --swa-full --no-context-shift',
  '--embedding --embeddings --pooling --no-slots',
].flatMap(line => line.split(' '));

const RUNTIME_ID = 'llama-server';
const LOOPBACK = '127.0.0.1';
const VERSION_TIMEOUT_MS = 10_000;
const HEALTH_POLL_MS = 200;
const HEALTH_REQUEST_TIMEOUT_MS = 1_000;
const LOG_LINES = 200;
const MAX_MESSAGE_LINE = 300;
const FLAG_RE = /^--?[a-zA-Z]/;
const TUNING_FLAGS = new Set(LLAMA_SERVER_TUNING_FLAGS);
// The two real listening lines, whole: model strings printed during the load cannot pass for them mid-line.
const LISTENING_RE =
  /^(?:\d+\.\d+\.\d+\.\d+ [A-Z] )?(?:main: HTTP server is listening, hostname: 127\.0\.0\.1, port: (\d+), http threads: \d+|srv +server_on_li: listening on http:\/\/127\.0\.0\.1:(\d+))$/;
const BATCH_FILE_RE = /\.(bat|cmd)$/i;

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

function assertBinaryPath(path: string): void {
  // Node refuses to spawn batch files without a shell, and a shell would parse the arguments.
  if (BATCH_FILE_RE.test(path)) throw new LlamaServerBinaryError(`${path} is a batch file, not llama-server`, path);
}

/**
 * Finds a llama-server of at least `MIN_LLAMA_SERVER_BUILD`: `options.path`, else the first on PATH (null when PATH
 * has none). Never downloads one; a build too old throws `LlamaServerVersionError`.
 */
export async function findLlamaServer(options: FindLlamaServerOptions = {}): Promise<LlamaServerBinary | null> {
  const timeoutMs = options.timeoutMs ?? VERSION_TIMEOUT_MS;
  const env = options.env ?? process.env;
  if (options.path !== undefined) {
    assertBinaryPath(options.path);
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
      { timeout: timeoutMs, windowsHide: true, env: childEnv(env, path) },
      (error, stdout, stderr) => done({ text: `${stdout}\n${stderr}`, error })
    );
  });
  const version = /^version:\s*(.+?)\s*$/m.exec(output.text)?.[1];
  if (!version) return fail(output.error ? `could not run: ${output.error.message}` : 'is not llama-server');
  const build = /\bbuild (\d+)/.exec(version)?.[1] ?? /^(\d+) \(/.exec(version)?.[1];
  return { path, version, build: build ? Number(build) : null };
}

/** The parent's environment without llama.cpp settings or HF tokens; older Linux zips need their own library dir. */
function childEnv(env: NodeJS.ProcessEnv, binaryPath: string): NodeJS.ProcessEnv {
  const child = Object.fromEntries(
    Object.entries(env).filter(([name]) => !/^LLAMA_/i.test(name) && !/^(HF_TOKEN|HUGGING_FACE_HUB_TOKEN)$/i.test(name))
  );
  const dir = dirname(resolve(binaryPath));
  if (process.platform === 'linux' && existsSync(join(dir, 'libllama.so')))
    child.LD_LIBRARY_PATH = child.LD_LIBRARY_PATH ? `${dir}:${child.LD_LIBRARY_PATH}` : dir;
  return child;
}

export interface LlamaServerTuning {
  /** Context size in tokens; 0 takes the model's training context. Default `DEFAULT_LLAMA_SERVER_CONTEXT_SIZE`. */
  contextSize?: number;
  /** Generation threads; llama.cpp picks the physical core count when unset. */
  threads?: number;
  /** Layers offloaded to the GPU; llama.cpp's default when unset. */
  gpuLayers?: number;
  /** Appended last: flags from `LLAMA_SERVER_TUNING_FLAGS` only, each value as its own argument. */
  extraArgs?: readonly string[];
}

export interface StartLlamaServerOptions extends LlamaServerTuning {
  binaryPath: string;
  /**
   * Placed before llama-server's own arguments, for a `binaryPath` that is a launcher. The launcher must pass the
   * environment through (the key travels in it) and should `exec` llama-server.
   */
  binaryArgs?: readonly string[];
  modelPath: string;
  /** Model id the server answers to on `/v1`; default the file name. No commas: llama-server splits on them. */
  alias?: string;
  /** A fixed loopback port; default a port the server picks itself. */
  port?: number;
  /** Gives up when the server is not ready this long after spawning (ms). Default no limit: loads can be silent. */
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
  /** Ends the process and its children (SIGTERM, then SIGKILL after `stopTimeoutMs`) and resolves once it is gone. */
  stop(): Promise<LlamaServerExit>;
}

const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

/** Signals the process and everything it started: its process group on POSIX, its tree on Windows. */
function signalTree(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL', sync = false): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    const args = ['/PID', String(pid), '/T', '/F'];
    if (sync) spawnSync('taskkill', args, { windowsHide: true, stdio: 'ignore' });
    else spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill(signal));
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
  }
}

// An 'exit' listener may only do synchronous work.
function killLiveChildren(): void {
  for (const child of liveChildren) signalTree(child, 'SIGKILL', true);
}

function track(child: ChildProcess): void {
  if (!exitHookInstalled) {
    process.on('exit', killLiveChildren);
    exitHookInstalled = true;
  }
  liveChildren.add(child);
  child.once('exit', () => {
    liveChildren.delete(child);
    // A launcher that exits first would leave llama-server running where stop() cannot reach it.
    if (process.platform !== 'win32' && child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // ESRCH: the group is already gone.
      }
    }
  });
  // A child that never spawned emits 'error' and no 'exit'.
  child.once('error', () => {
    if (child.pid === undefined) liveChildren.delete(child);
  });
}

/** For tests: whether the parent-exit hook still holds a process. */
export function trackedLlamaServerCount(): number {
  return liveChildren.size;
}

class ManagedLlamaServer implements LlamaServerProcess {
  readonly exited: Promise<LlamaServerExit>;
  /** Resolves with the port once the process itself logs that it is listening. */
  readonly listening: Promise<number>;
  exit: LlamaServerExit | null = null;
  spawnError: Error | null = null;
  onExit: ((exit: LlamaServerExit) => void) | undefined;
  #port = 0;
  #runtime: OpenAICompatibleRuntime | null = null;
  readonly #lines: string[] = [];
  #stopping = false;

  constructor(
    readonly child: ChildProcess,
    readonly apiKey: string,
    readonly model: string,
    readonly modelPath: string,
    readonly contextSize: number,
    private readonly stopTimeoutMs: number,
    private readonly fetchImpl: FetchLike,
    onLog: ((line: string) => void) | undefined
  ) {
    let heard: (port: number) => void = () => undefined;
    this.listening = new Promise(done => (heard = done));
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      createInterface({ input: stream, crlfDelay: Infinity }).on('line', line => {
        this.#lines.push(line);
        if (this.#lines.length > LOG_LINES) this.#lines.shift();
        const match = LISTENING_RE.exec(line);
        const port = Number(match?.[1] ?? match?.[2] ?? 0);
        if (port > 0 && this.#port === 0) {
          this.#port = port;
          heard(port);
        }
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

  get port(): number {
    return this.#port;
  }

  get baseUrl(): string {
    return `http://${LOOPBACK}:${this.#port}`;
  }

  get client(): HttpClient {
    return { runtimeId: RUNTIME_ID, baseUrl: this.baseUrl, fetch: this.fetchImpl };
  }

  get running(): boolean {
    return this.exit === null;
  }

  log(): string[] {
    return [...this.#lines];
  }

  /** Status of `path` asked without the key. */
  async statusWithoutKey(path: string): Promise<number | null> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => undefined);
      return response.status;
    } catch {
      return null;
    }
  }

  /** Whether `/v1/models`, asked with this server's key, lists its alias. */
  async serves(): Promise<boolean> {
    this.#runtime ??= new OpenAICompatibleRuntime({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      product: 'llama-server',
      fetch: this.fetchImpl,
    });
    const served = await this.#runtime.list().catch(() => []);
    return served.some(entry => entry.name === this.model);
  }

  async stop(): Promise<LlamaServerExit> {
    if (this.exit) return this.exit;
    this.#stopping = true;
    signalTree(this.child, 'SIGTERM');
    const timer = setTimeout(() => signalTree(this.child, 'SIGKILL'), this.stopTimeoutMs);
    try {
      return await this.exited;
    } finally {
      clearTimeout(timer);
    }
  }

  startError(reason: LlamaServerStartError['reason'], message: string): LlamaServerStartError {
    return new LlamaServerStartError(message, reason, this.log());
  }

  exitError(binaryPath: string, port: number | undefined): LlamaServerExitError {
    const lines = this.log();
    if (this.spawnError) {
      const message = `could not run ${binaryPath}: ${this.spawnError.message}`;
      return new LlamaServerExitError(message, null, null, false, lines);
    }
    const { code, signal } = this.exit ?? { code: null, signal: null };
    const portInUse = lines.some(line => /couldn't bind|address already in use/i.test(line));
    const reason = portInUse
      ? `port ${port ?? this.#port} is in use`
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

function serverArgs(options: StartLlamaServerOptions, alias: string, contextSize: number): string[] {
  return [
    ...(options.binaryArgs ?? []),
    '--model',
    options.modelPath,
    '--alias',
    alias,
    '--host',
    LOOPBACK,
    '--port',
    String(options.port ?? 0),
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

/**
 * Whether a process in process group `pgid` holds the socket listening on loopback `port` (Linux only): a model
 * string with a newline in it could still print a whole forged listening line.
 */
async function listenerInGroup(port: number, pgid: number): Promise<boolean> {
  const local = `:${port.toString(16).toUpperCase().padStart(4, '0')}`;
  const table = await readFile('/proc/net/tcp', 'utf8').catch(() => '');
  const sockets = new Set<string>();
  for (const row of table.split('\n').slice(1)) {
    const fields = row.trim().split(/\s+/);
    if (fields[1]?.endsWith(local) && fields[3] === '0A') sockets.add(`socket:[${fields[9]}]`);
  }
  if (sockets.size === 0) return false;
  for (const pid of await readdir('/proc').catch(() => [])) {
    if (!/^\d+$/.test(pid)) continue;
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
    // After the parenthesized command name: state, ppid, pgrp.
    if (Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]) !== pgid) continue;
    for (const fd of await readdir(`/proc/${pid}/fd`).catch(() => [])) {
      if (sockets.has(await readlink(`/proc/${pid}/fd/${fd}`).catch(() => ''))) return true;
    }
  }
  return false;
}

const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms).unref());

/**
 * Starts llama-server on loopback with a fresh API key in its environment. Resolves once it has logged its port,
 * `/health` answers, `/props` refuses a request without the key and `/v1/models` serves the model with it.
 */
export async function startLlamaServer(options: StartLlamaServerOptions): Promise<LlamaServerProcess> {
  options.signal?.throwIfAborted();
  assertBinaryPath(options.binaryPath);
  assertTuning(options);
  if (options.port !== undefined && !(Number.isInteger(options.port) && options.port > 0 && options.port < 65536))
    throw new LocalRuntimeError('port must be an integer from 1 to 65535', RUNTIME_ID);
  const alias = options.alias ?? basename(options.modelPath);
  if (!alias || alias.includes(','))
    throw new LocalRuntimeError(`${JSON.stringify(alias)} cannot be a llama-server alias`, RUNTIME_ID);
  const file = await stat(options.modelPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw storageError(RUNTIME_ID, options.modelPath, error, 'read');
  });
  if (!file?.isFile()) throw new ModelNotFoundError(RUNTIME_ID, options.modelPath);

  const apiKey = randomBytes(32).toString('base64url');
  const contextSize = options.contextSize ?? DEFAULT_LLAMA_SERVER_CONTEXT_SIZE;
  let child: ChildProcess;
  try {
    child = spawn(options.binaryPath, serverArgs(options, alias, contextSize), {
      env: { ...childEnv(options.env ?? process.env, options.binaryPath), LLAMA_API_KEY: apiKey },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Its own process group, so stop() reaches whatever a launcher started.
      detached: process.platform !== 'win32',
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new LlamaServerExitError(`could not run ${options.binaryPath}: ${reason}`, null, null, false, [], {
      cause: error,
    });
  }
  track(child);
  const server = new ManagedLlamaServer(
    child,
    apiKey,
    alias,
    options.modelPath,
    contextSize,
    options.stopTimeoutMs ?? DEFAULT_LLAMA_SERVER_STOP_TIMEOUT_MS,
    options.fetch ?? fetch,
    options.onLog
  );
  const aborted = untilAborted(options.signal);
  try {
    await waitUntilReady(server, options, aborted.promise);
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

async function waitUntilReady(
  server: ManagedLlamaServer,
  options: StartLlamaServerOptions,
  aborted: Promise<void>
): Promise<void> {
  const timeoutMs = options.startTimeoutMs;
  const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
  const check = () => {
    options.signal?.throwIfAborted();
    if (!server.running) throw server.exitError(options.binaryPath, options.port);
    if (Date.now() > deadline) throw server.startError('timeout', `llama-server was not ready within ${timeoutMs}ms`);
  };
  const pause = () => Promise.race([delay(HEALTH_POLL_MS), server.exited, aborted]);
  // Until the process names its port, whatever answers on a port is not known to be it.
  while (server.port === 0) {
    check();
    await Promise.race([server.listening, pause()]);
  }
  if (options.port !== undefined && server.port !== options.port)
    throw server.startError('wrong-server', `llama-server reported port ${server.port}, not ${options.port}`);
  while (true) {
    check();
    const healthy = await requestJson(server.client, '/health', healthSchema, {
      timeoutMs: HEALTH_REQUEST_TIMEOUT_MS,
      signal: options.signal,
    }).then(
      () => true,
      () => false
    );
    if (healthy) break;
    await pause();
  }
  if (process.platform === 'linux' && !(await listenerInGroup(server.port, server.pid)))
    throw server.startError('wrong-server', `port ${server.port} is not held by the llama-server just started`);
  const status = await server.statusWithoutKey('/props');
  if (status !== 401) {
    throw server.startError(
      'unauthenticated',
      `llama-server answered /props without its API key (${status ?? 'no answer'}); a launcher must pass LLAMA_API_KEY through`
    );
  }
  if (!(await server.serves()))
    throw server.startError('wrong-server', `port ${server.port} answered, but not as the llama-server just started`);
  check();
}

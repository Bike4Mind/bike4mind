import { spawn, type ChildProcess } from 'node:child_process';
import { access, constants, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { createInterface } from 'node:readline';
import { LocalRuntimeError } from './errors';
import { signalTree, trackChild } from './processTree';
import type { FetchLike } from './types';

export const OLLAMA_SERVE_RUNTIME_ID = 'ollama';
export const DEFAULT_OLLAMA_SERVE_START_TIMEOUT_MS = 30_000;
export const DEFAULT_OLLAMA_SERVE_STOP_TIMEOUT_MS = 5_000;

const LOOPBACK = '127.0.0.1';
const LOG_LINES = 200;
const POLL_MS = 200;
const VERSION_TIMEOUT_MS = 1_000;
const MAX_MESSAGE_LINE = 300;
// slog's `msg="Listening on 127.0.0.1:11434 (version 0.12.0)"`, printed once the listener is bound.
const LISTENING_RE = /\bmsg="Listening on (\S+) \(version [^)]*\)"/;
const PORT_IN_USE_RE = /address already in use|Only one usage of each socket address/i;

/** The variables Desktop owns on an `ollama serve` it starts; inherited values of these are dropped. */
export const OLLAMA_LAUNCH_KEYS = ['OLLAMA_HOST', 'OLLAMA_KV_CACHE_TYPE', 'OLLAMA_FLASH_ATTENTION'] as const;

export interface OllamaLaunchSettings {
  /** OLLAMA_KV_CACHE_TYPE for every model; unset is Ollama's f16. */
  kvCacheType?: string;
  /** OLLAMA_FLASH_ATTENTION; unset leaves it to Ollama, per GPU. */
  flashAttention?: boolean;
}

/**
 * The OLLAMA_* values an `ollama serve` gets for `settings`. A quantized cache turns flash attention on when it is
 * unset: Ollama fails to load a model with one while flash attention is off.
 */
export function ollamaLaunchEnv(settings: OllamaLaunchSettings): Record<string, string> {
  const kv = settings.kvCacheType?.trim().toLowerCase();
  const quantized = !!kv && kv !== 'f16' && kv !== 'bf16' && kv !== 'f32';
  const flash = settings.flashAttention ?? (quantized ? true : undefined);
  return {
    ...(kv ? { OLLAMA_KV_CACHE_TYPE: kv } : {}),
    ...(flash === undefined ? {} : { OLLAMA_FLASH_ATTENTION: flash ? '1' : '0' }),
  };
}

export interface FindOllamaOptions {
  /** The PATH to search; default this process's. */
  path?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  isExecutable?: (file: string) => Promise<boolean>;
}

async function executableFile(file: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false;
    if (platform !== 'win32') await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Where the Ollama apps put the binary when it is not on PATH: the macOS app bundle and the Windows installer. */
function installedLocations(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
  if (platform === 'darwin') {
    const bundled = 'Ollama.app/Contents/Resources/ollama';
    return [posix.join('/Applications', bundled), posix.join(home, 'Applications', bundled)];
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local');
    return [win32.join(local, 'Programs', 'Ollama', 'ollama.exe')];
  }
  return ['/usr/local/bin/ollama', '/usr/bin/ollama', posix.join(home, '.local', 'bin', 'ollama')];
}

/** The `ollama` binary: the first on PATH (absolute entries only), else where the installers put it. Null if none. */
export async function findOllamaBinary(options: FindOllamaOptions = {}): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const windows = platform === 'win32';
  const flavor = windows ? win32 : posix;
  const isExecutable = options.isExecutable ?? (file => executableFile(file, platform));
  const path = options.path ?? env.PATH ?? env.Path ?? '';
  const onPath = path
    .split(windows ? ';' : ':')
    .map(entry => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter(entry => entry && flavor.isAbsolute(entry) && (!windows || /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/])/i.test(entry)))
    .map(entry => flavor.join(entry, windows ? 'ollama.exe' : 'ollama'));
  for (const candidate of [...onPath, ...installedLocations(platform, env, options.home ?? homedir())]) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

export class OllamaServeError extends LocalRuntimeError {
  constructor(
    message: string,
    /** Another process holds the port. */
    readonly portInUse: boolean,
    /** The last lines it printed. */
    readonly log: readonly string[],
    options?: { cause?: unknown }
  ) {
    super(message, OLLAMA_SERVE_RUNTIME_ID, options);
    this.name = 'OllamaServeError';
  }
}

export interface OllamaServeExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** True when `stop()` ended it; false for a crash or an outside kill. */
  stopped: boolean;
}

export interface StartOllamaServeOptions {
  binaryPath: string;
  /** Placed before `serve`, for a `binaryPath` that is a launcher; it must pass the environment through. */
  binaryArgs?: readonly string[];
  /** The loopback port it listens on. */
  port: number;
  settings?: OllamaLaunchSettings;
  /** The environment it inherits, without Desktop's own OLLAMA_LAUNCH_KEYS; default this process's. */
  env?: NodeJS.ProcessEnv;
  /** Gives up when it is not answering this long after spawning (ms). */
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  signal?: AbortSignal;
  fetch?: FetchLike;
  onLog?: (line: string) => void;
  /** Called once when the process exits after a successful start, whether stopped or crashed. */
  onExit?: (exit: OllamaServeExit) => void;
}

export interface OllamaServeProcess {
  readonly pid: number;
  readonly port: number;
  /** `http://127.0.0.1:<port>`. */
  readonly baseUrl: string;
  /** The launch variables it was given: OLLAMA_HOST and those from `ollamaLaunchEnv`. */
  readonly launchEnv: Readonly<Record<string, string>>;
  readonly exited: Promise<OllamaServeExit>;
  readonly running: boolean;
  log(): string[];
  /** Ends the process and its runners (SIGTERM, then SIGKILL after `stopTimeoutMs`) and resolves once it is gone. */
  stop(): Promise<OllamaServeExit>;
}

function childEnv(env: NodeJS.ProcessEnv, launch: Record<string, string>): NodeJS.ProcessEnv {
  const owned = new Set<string>(OLLAMA_LAUNCH_KEYS);
  const child = Object.fromEntries(Object.entries(env).filter(([name]) => !owned.has(name.toUpperCase())));
  return { ...child, ...launch };
}

/**
 * Runs `ollama serve` on a loopback port with `settings` in its environment. Resolves once that process has logged
 * its listener on the port and `/api/version` answers while it still runs: an Ollama already on the port makes it
 * exit with "address already in use", so whatever answers then is the process started here.
 */
export async function startOllamaServe(options: StartOllamaServeOptions): Promise<OllamaServeProcess> {
  options.signal?.throwIfAborted();
  const { port } = options;
  if (!(Number.isInteger(port) && port > 0 && port < 65536))
    throw new LocalRuntimeError('port must be an integer from 1 to 65535', OLLAMA_SERVE_RUNTIME_ID);
  const host = `${LOOPBACK}:${port}`;
  const launchEnv = { OLLAMA_HOST: host, ...ollamaLaunchEnv(options.settings ?? {}) };
  let child: ChildProcess;
  try {
    child = spawn(options.binaryPath, [...(options.binaryArgs ?? []), 'serve'], {
      env: childEnv(options.env ?? process.env, launchEnv),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Its own process group, so stop() reaches the runners it starts.
      detached: process.platform !== 'win32',
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new OllamaServeError(`could not run ${options.binaryPath}: ${reason}`, false, [], { cause: error });
  }
  trackChild(child);

  const lines: string[] = [];
  let listening = false;
  let exit: OllamaServeExit | null = null;
  let spawnError: Error | null = null;
  let stopping = false;
  // Set only once ready: an exit during the start is the start's error, not the caller's notice.
  const listeners: { onExit?: (exit: OllamaServeExit) => void } = {};
  let wake = () => undefined as void;
  let changed = new Promise<void>(done => (wake = done));
  const notify = () => {
    wake();
    changed = new Promise<void>(done => (wake = done));
  };
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    createInterface({ input: stream, crlfDelay: Infinity }).on('line', line => {
      lines.push(line);
      if (lines.length > LOG_LINES) lines.shift();
      if (!listening && LISTENING_RE.exec(line)?.[1] === host) {
        listening = true;
        notify();
      }
      try {
        options.onLog?.(line);
      } catch {
        // A throwing log callback must not take down the reader.
      }
    });
  }
  const exited = new Promise<OllamaServeExit>(done => {
    const finish = (result: OllamaServeExit) => {
      if (exit) return;
      exit = result;
      done(result);
      notify();
      try {
        listeners.onExit?.(result);
      } catch {
        // The caller's callback cannot fail the process bookkeeping.
      }
    };
    child.once('exit', (code, signal) => finish({ code, signal, stopped: stopping }));
    // `on`, not `once`: a later 'error' (a failed kill) with no listener would crash the host process.
    child.on('error', error => {
      if (child.pid !== undefined) return;
      spawnError = error;
      finish({ code: null, signal: null, stopped: false });
    });
  });

  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_OLLAMA_SERVE_STOP_TIMEOUT_MS;
  const stop = async (): Promise<OllamaServeExit> => {
    if (exit) return exit;
    stopping = true;
    signalTree(child, 'SIGTERM');
    const timer = setTimeout(() => signalTree(child, 'SIGKILL'), stopTimeoutMs);
    try {
      return await exited;
    } finally {
      clearTimeout(timer);
    }
  };
  const baseUrl = `http://${host}`;
  const fetchImpl = options.fetch ?? fetch;
  const answers = async () => {
    try {
      const response = await fetchImpl(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(VERSION_TIMEOUT_MS) });
      const body = (await response.json().catch(() => null)) as { version?: unknown } | null;
      return response.ok && typeof body?.version === 'string';
    } catch {
      return false;
    }
  };
  const exitError = (): OllamaServeError => {
    if (spawnError)
      return new OllamaServeError(`could not run ${options.binaryPath}: ${spawnError.message}`, false, []);
    const portInUse = lines.some(line => PORT_IN_USE_RE.test(line));
    const { code, signal } = exit ?? { code: null, signal: null };
    const reason = portInUse
      ? `port ${port} is in use`
      : (lines.filter(line => /\b(error|level=ERROR)\b/i.test(line)).at(-1) ?? lines.at(-1) ?? 'no output');
    const how = signal ? `signal ${signal}` : `code ${code}`;
    const message = `ollama serve exited before it was ready (${how}): ${reason.trim().slice(0, MAX_MESSAGE_LINE)}`;
    return new OllamaServeError(message, portInUse, [...lines]);
  };

  const timeoutMs = options.startTimeoutMs ?? DEFAULT_OLLAMA_SERVE_START_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<void>(done => {
    if (!options.signal) return;
    abortListener = () => done();
    options.signal.addEventListener('abort', abortListener, { once: true });
  });
  try {
    while (true) {
      options.signal?.throwIfAborted();
      if (exit) throw exitError();
      if (Date.now() > deadline) {
        // Readiness hinges on LISTENING_RE, so a changed Ollama log line shows up here.
        const hint =
          !listening && (await answers()) ? `: it answers at ${host} but never logged "Listening on ${host}"` : '';
        throw new OllamaServeError(`ollama serve was not ready within ${timeoutMs}ms${hint}`, false, [...lines]);
      }
      if (listening && (await answers()) && !exit) break;
      await Promise.race([new Promise(done => setTimeout(done, POLL_MS).unref()), changed, aborted]);
    }
    // An abort during the last readiness check must not hand back a running server.
    options.signal?.throwIfAborted();
  } catch (error) {
    await stop();
    options.signal?.throwIfAborted();
    throw error;
  } finally {
    if (abortListener) options.signal?.removeEventListener('abort', abortListener);
  }
  listeners.onExit = options.onExit;
  return {
    pid: child.pid ?? -1,
    port,
    baseUrl,
    launchEnv,
    exited,
    get running() {
      return exit === null;
    },
    log: () => [...lines],
    stop,
  };
}

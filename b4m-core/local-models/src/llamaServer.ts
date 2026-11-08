import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, constants, readFile, readdir, readlink, realpath, stat } from 'node:fs/promises';
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
import { stopTree, trackChild, trackedChildCount } from './processTree';
import type { FetchLike } from './types';

/** Used when the caller passes no `contextSize`; callers such as Desktop pass one sized to the hardware. */
export const DEFAULT_LLAMA_SERVER_CONTEXT_SIZE = 16384;
export const DEFAULT_LLAMA_SERVER_STOP_TIMEOUT_MS = 5_000;
/** First llama.cpp release with `--offline`; `--jinja`, `--no-webui`, `--port 0` and `LLAMA_API_KEY` are older. */
export const MIN_LLAMA_SERVER_BUILD = 5501;

/**
 * The only flags `extraArgs` may pass: same values in b5501 and current builds (`--flash-attn` changed, so it is the
 * typed `flashAttention`). Anything else could expose the server, fetch over the network, write files, or override a
 * flag this module sets.
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
export const VERSION_TIMEOUT_MS = 10_000;
const HEALTH_POLL_MS = 200;
const HEALTH_REQUEST_TIMEOUT_MS = 1_000;
const LOG_LINES = 200;
const MAX_MESSAGE_LINE = 300;
const FLAG_RE = /^--?[a-zA-Z]/;
const TUNING_FLAGS = new Set(LLAMA_SERVER_TUNING_FLAGS);
// The real listening lines, whole: model strings printed during the load cannot pass for them mid-line.
const LISTENING_RE =
  /^(?:\d+\.\d+\.\d+\.\d+ [A-Z] )?(?:main: HTTP server is listening, hostname: 127\.0\.0\.1, port: (\d+), http threads: \d+|(?:srv +server_on_li: listening on|main: server is listening on) http:\/\/127\.0\.0\.1:(\d+)(?: - starting the main loop)?)$/;
// b5501 prints `main: model loaded`, current builds `srv  server_run_i: model loaded`; both come after the load.
const MODEL_LOADED_RE = /^(?:\d+\.\d+\.\d+\.\d+ [A-Z] )?(?:main|srv +server_run_i): model loaded$/;
/**
 * How long after its model loaded a server may go without a port this module can confirm (ms). Loads can be silent
 * for any length of time, but both known builds name their port right after this line.
 */
export const LLAMA_SERVER_PORT_GRACE_MS = 30_000;
const SOCKET_SCAN_MS = 1_000;
// Known builds print their line right after the load; only then may an unrecognized build's lone listener be taken.
const UNNAMED_PORT_SETTLE_MS = 2_000;
const MAX_GROUP_PROCESSES = 256;
/** First release whose `-fa` takes `on`, `off` or `auto`; older builds take a bare `-fa` switch. */
export const LLAMA_SERVER_FLASH_ATTN_VALUE_BUILD = 6325;
/** First build with `--fit` and its per-device `--fit-target` (MiB); older builds take neither. */
export const LLAMA_SERVER_FIT_TARGET_BUILD = 7407;
// What the dynamic loader prints for a missing shared library: glibc, then macOS dyld.
const MISSING_LIBRARY_RE =
  /error while loading shared libraries: ([^:\s]+): cannot open shared object file|Library not loaded: (\S+)/;
// STATUS_DLL_NOT_FOUND as Node reports the exit code of a process Windows could not start.
const DLL_NOT_FOUND_CODES: readonly unknown[] = [3221225781, -1073741515];
// oneAPI libraries a SYCL build links: SYCL, Unified Runtime, Level Zero, MKL, oneDNN, TBB, UMF, compiler runtime.
const ONEAPI_LIBRARY_RE = /^(?:lib)?(?:sycl|ur_|ze_loader|mkl_|dnnl|svml|imf|intlc|irng|iomp5|tbb|umf)/i;
const GPU_BACKEND_LIBRARY_RE = /^(?:lib)?ggml-(sycl|vulkan)\.(?:so|dll|dylib)$/i;
// A device line `--list-devices` prints to stdout (common/arg.cpp): `  SYCL0: <description> (<total> MiB, <free> MiB free)`.
const LISTED_DEVICE_RE = /^ {2}(\S+): (.+) \((\d+) MiB, (\d+) MiB free\)\s*$/;
const MIB = 1024 * 1024;
// A listing that failed is retried after this long (ms), so a driver installed since is seen.
const FAILED_LISTING_RETRY_MS = 60_000;
const UNQUANTIZED_CACHE_TYPES = new Set(['f32', 'f16', 'bf16']);
const BATCH_FILE_RE = /\.(bat|cmd)$/i;

const healthSchema = z.object({ status: z.string() });
const routerPropsSchema = z.object({ role: z.literal('router') });
// What llama.cpp prints for a flag it does not know, as a build from before router mode does for --models-dir.
const NO_ROUTER_RE = /\b(?:invalid|unknown) argument: --models-dir\b/;

export interface LlamaServerBinary {
  path: string;
  /** The `--version` line after `version:`, e.g. `0.7.0-dev (build 11912, commit 961c376a2)`. */
  version: string;
  /** The llama.cpp release number (`b11912` is 11912); at least `MIN_LLAMA_SERVER_BUILD`. */
  build: number;
  /** A SYCL or Vulkan build that lists no GPU, which runs on the CPU: why, and what lets it use the GPU. */
  warning?: string;
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
 * has none). Never downloads one. A build too old throws `LlamaServerVersionError`; one that cannot start for a
 * missing library throws `LlamaServerBinaryError`. On PATH, either is thrown only when no entry qualifies. A SYCL or
 * Vulkan build that lists no GPU is returned with a `warning`.
 */
export async function findLlamaServer(options: FindLlamaServerOptions = {}): Promise<LlamaServerBinary | null> {
  const timeoutMs = options.timeoutMs ?? VERSION_TIMEOUT_MS;
  const env = options.env ?? process.env;
  if (options.path !== undefined) {
    assertBinaryPath(options.path);
    const path = resolve(options.path);
    const found = await probeBinary(path, env, timeoutMs, true, options.binaryArgs);
    const binary = checkBuild(found as NonNullable<typeof found>);
    return gpuBackendCheck(binary, (found as NonNullable<typeof found>).text, env, timeoutMs, options.binaryArgs);
  }
  const windows = (options.platform ?? process.platform) === 'win32';
  const dirs = (env.PATH ?? env.Path ?? '').split(windows ? ';' : ':');
  let problem: LlamaServerVersionError | LlamaServerBinaryError | null = null;
  for (const dir of dirs) {
    // A relative entry would resolve against this process's working directory.
    if (!dir || !isAbsolute(dir)) continue;
    try {
      const found = await probeBinary(join(dir, windows ? 'llama-server.exe' : 'llama-server'), env, timeoutMs, false);
      if (!found) continue;
      return await gpuBackendCheck(checkBuild(found), found.text, env, timeoutMs);
    } catch (error) {
      if (!(error instanceof LlamaServerVersionError || error instanceof LlamaServerBinaryError)) throw error;
      problem ??= error;
    }
  }
  if (problem) throw problem;
  return null;
}

function checkBuild(found: { path: string; version: string; build: number | null }): LlamaServerBinary {
  if (found.build === null || found.build < MIN_LLAMA_SERVER_BUILD)
    throw new LlamaServerVersionError(found.path, found.build, MIN_LLAMA_SERVER_BUILD);
  return { path: found.path, version: found.version, build: found.build };
}

interface BinaryRun {
  text: string;
  stdout: string;
  /** `killed` after a timeout; `previous` when an earlier listing of a replaced binary still runs. */
  error: (Error & { code?: unknown; killed?: boolean; previous?: boolean }) | null;
  /** Settles once the child has exited, which one stuck in a driver call does not do even after SIGKILL. */
  exited: Promise<void>;
  /** Undefined when it could not be spawned. */
  pid: number | undefined;
}

function runBinary(path: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<BinaryRun> {
  return new Promise(done => {
    const started = Date.now();
    const timedOut = () =>
      Object.assign(new Error(`${path} did not exit within ${timeoutMs} ms`), { killed: true as const });
    // Filled in once spawned; a spawn that throws settles with none of it.
    const spawned: { backstop?: ReturnType<typeof setTimeout>; exited: Promise<void>; pid?: number } = {
      exited: Promise.resolve(),
    };
    let settled = false;
    const settle = (run: Omit<BinaryRun, 'exited' | 'pid'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(spawned.backstop);
      done({ ...run, exited: spawned.exited, pid: spawned.pid });
    };
    let child: ChildProcess;
    try {
      child = execFile(
        path,
        args,
        { timeout: timeoutMs, windowsHide: true, env: childEnv(env, path) },
        (error, stdout, stderr) => {
          // A wrapper that exited 0 while a grandchild held its output is cut off by the timeout with no error.
          const cut = !error && (child.killed || Date.now() - started >= timeoutMs);
          settle({ text: `${stdout}\n${stderr}`, stdout: String(stdout), error: cut ? timedOut() : error });
        }
      );
    } catch (error) {
      // Spawn throws, rather than reporting, for ETXTBSY, E2BIG, EPERM and others.
      settle({ text: '', stdout: '', error: error instanceof Error ? error : new Error(String(error)) });
      return;
    }
    spawned.pid = child.pid;
    spawned.exited = new Promise<void>(resolve => {
      child.once('exit', () => resolve());
      child.once('error', () => resolve());
    });
    // execFile's timeout sends SIGTERM and reports only once the child exits, which one that traps it, is stuck in a
    // driver call, or leaves a grandchild holding its output never does.
    spawned.backstop = setTimeout(() => {
      child.kill('SIGKILL');
      settle({ text: '', stdout: '', error: timedOut() });
    }, timeoutMs + 1_000);
    spawned.backstop.unref();
  });
}

/** One GPU from `llama-server --list-devices`. */
export interface ListedDevice {
  /** The backend's device name, e.g. `SYCL0` or `Vulkan1`. */
  name: string;
  description: string;
  totalBytes: number;
  /** Equals `totalBytes` when the backend cannot read it (SYCL without Level Zero Sysman, Vulkan without a budget). */
  freeBytes: number;
}

/** The device lines of `--list-devices` stdout; the CPU is never listed, and `  (none)` gives []. */
export function parseListedDevices(stdout: string): ListedDevice[] {
  return stdout.split(/\r?\n/).flatMap((line): ListedDevice[] => {
    const match = LISTED_DEVICE_RE.exec(line);
    if (!match) return [];
    const total = Number(match[3]);
    const free = Number(match[4]);
    if (!Number.isSafeInteger(total * MIB) || total <= 0 || !Number.isSafeInteger(free)) return [];
    const freeBytes = free > total ? total * MIB : free * MIB;
    return [{ name: match[1], description: match[2].trim(), totalBytes: total * MIB, freeBytes }];
  });
}

interface DeviceListing {
  stamp: string;
  /** When it started, or when the child of a run killed for its time exited. */
  at: number;
  run: Promise<BinaryRun>;
  done: boolean;
  /** A run killed for its time whose child has not exited. */
  stuck: boolean;
}

const deviceListings = new Map<string, DeviceListing>();

/**
 * Runs `--list-devices`, or reuses a run of the same unchanged binary under the same environment that is still running
 * or started at most `maxAgeMs` ago; one that failed or listed no device for at most `FAILED_LISTING_RETRY_MS`. A run
 * killed for its time is reused until its child exits, so a binary stuck in a driver call keeps one process at most.
 */
async function listDevicesRun(
  path: string,
  binaryArgs: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  maxAgeMs: number
): Promise<BinaryRun> {
  const stats = await stat(path).catch(() => {
    throw new LlamaServerBinaryError(`llama-server at ${path} is missing or not executable`, path);
  });
  // The environment decides what a backend finds (library paths, setvars.sh, device filters).
  const environment = createHash('sha256')
    .update(JSON.stringify(Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))
    .digest('hex');
  const key = JSON.stringify([path, environment, timeoutMs, ...binaryArgs]);
  const stamp = `${stats.mtimeMs}:${stats.size}`;
  const cached = deviceListings.get(key);
  if (cached && cached.stamp === stamp && (!cached.done || cached.stuck)) return cached.run;
  if (cached?.stuck) {
    const { pid, exited } = await cached.run;
    const message = `an earlier \`llama-server --list-devices\` (pid ${pid ?? 'unknown'}) of the previous binary has not exited; end it or restart the computer`;
    return { text: '', stdout: '', error: Object.assign(new Error(message), { previous: true }), exited, pid };
  }
  if (cached && cached.stamp === stamp && Date.now() - cached.at <= maxAgeMs) {
    const run = await cached.run;
    const listed = !run.error && parseListedDevices(run.stdout).length > 0;
    if (listed || Date.now() - cached.at <= FAILED_LISTING_RETRY_MS) return run;
  }
  const run = runBinary(path, [...binaryArgs, '--list-devices'], env, timeoutMs);
  const entry: DeviceListing = { stamp, at: Date.now(), run, done: false, stuck: false };
  const current = () => deviceListings.get(key) === entry;
  void run.then(
    ({ error, exited, pid }) => {
      entry.done = true;
      // Not spawned at all (a file being written, say): nothing ran, so the next caller tries again.
      if (pid === undefined && current()) deviceListings.delete(key);
      if (!error?.killed) return;
      entry.stuck = true;
      void exited.then(() => {
        entry.stuck = false;
        entry.at = Date.now();
      });
    },
    () => {
      if (current()) deviceListings.delete(key);
    }
  );
  deviceListings.set(key, entry);
  return run;
}

export interface ListLlamaServerDevicesOptions {
  path: string;
  /** Placed before `--list-devices`, for a binary that is a launcher. */
  binaryArgs?: readonly string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** How old a reused listing may be (ms); by default one is kept until the binary changes. */
  maxAgeMs?: number;
}

/**
 * The GPUs a SYCL or Vulkan build of llama-server lists, with their memory; [] for a build with neither backend beside
 * it, which is not run. Listing loads no model and allocates no device memory. Rejects when the binary is missing or
 * the listing fails or times out.
 */
export async function listLlamaServerDevices(options: ListLlamaServerDevicesOptions): Promise<ListedDevice[]> {
  assertBinaryPath(options.path);
  const path = resolve(options.path);
  const timeoutMs = options.timeoutMs ?? VERSION_TIMEOUT_MS;
  try {
    await access(path, constants.X_OK);
  } catch {
    throw new LocalRuntimeError(`llama-server at ${path} is missing or not executable`, RUNTIME_ID);
  }
  if ((await gpuBackends(path, '')).size === 0) return [];
  const env = options.env ?? process.env;
  const run = await listDevicesRun(path, options.binaryArgs ?? [], env, timeoutMs, options.maxAgeMs ?? Infinity);
  const devices = parseListedDevices(run.stdout);
  if (devices.length > 0 || !run.error) return devices;
  const why = run.error.killed ? `timed out after ${timeoutMs} ms` : run.error.message.split('\n')[0];
  throw new LocalRuntimeError(`llama-server at ${path} could not list its devices: ${why}`, RUNTIME_ID);
}

/** The GPU backends whose ggml library sits beside the binary, plus SYCL for an Intel oneAPI compiler build. */
async function gpuBackends(path: string, versionText: string): Promise<Set<string>> {
  // The libraries sit beside the real binary, not beside a symlink to it on PATH.
  const real = await realpath(path).catch(() => path);
  const files = await readdir(dirname(real)).catch((): string[] => []);
  const backends = new Set(files.flatMap(file => GPU_BACKEND_LIBRARY_RE.exec(file)?.[1].toLowerCase() ?? []));
  if (/^built with IntelLLVM\b/m.test(versionText)) backends.add('sycl');
  return backends;
}

const SYCL_HELP =
  "It needs Intel's GPU driver with Level Zero and the oneAPI runtime (on Linux, source oneAPI's setvars.sh before starting it), or use llama.cpp's Vulkan build instead.";

/** The error for a binary the loader could not start for a missing library; null when the output names none. */
export function missingLibraryError(
  path: string,
  text: string,
  error: { code?: unknown } | null,
  sycl: boolean
): LlamaServerBinaryError | null {
  const match = MISSING_LIBRARY_RE.exec(text);
  const library = match ? basename(match[1] ?? match[2]) : null;
  if (library === null && !DLL_NOT_FOUND_CODES.includes(error?.code)) return null;
  const what = library ?? 'a DLL it needs';
  let help = 'Install it, or use a llama.cpp build that does not need it.';
  if ((library !== null && ONEAPI_LIBRARY_RE.test(library)) || (library === null && sycl))
    help = `It is part of the Intel oneAPI runtime a SYCL build needs. ${SYCL_HELP}`;
  else if (library !== null && /^(?:lib)?vulkan/i.test(library))
    help = "Install the Vulkan loader and the GPU's Vulkan driver, or use a CPU build.";
  return new LlamaServerBinaryError(`llama-server at ${path} cannot start: ${what} is missing. ${help}`, path);
}

/**
 * A SYCL or Vulkan build whose backend finds no GPU still runs, silently on the CPU, so one that lists none comes back
 * with a warning; one that cannot start for a missing library throws. A build without either backend is not checked.
 */
async function gpuBackendCheck(
  binary: LlamaServerBinary,
  versionText: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  binaryArgs: readonly string[] = []
): Promise<LlamaServerBinary> {
  const backends = await gpuBackends(binary.path, versionText);
  if (backends.size === 0) return binary;
  const listed = await listDevicesRun(binary.path, binaryArgs, env, timeoutMs, Infinity);
  if (parseListedDevices(listed.stdout).length > 0) return binary;
  const sycl = backends.has('sycl');
  const missing = missingLibraryError(binary.path, listed.text, listed.error, sycl);
  if (missing) throw missing;
  const kind = [...backends].map(name => (name === 'sycl' ? 'SYCL' : 'Vulkan')).join(' and ');
  if (listed.error?.previous)
    return {
      ...binary,
      warning: `llama-server at ${binary.path} is a ${kind} build whose devices could not be listed: ${listed.error.message}.`,
    };
  if (listed.error?.killed)
    return {
      ...binary,
      warning: `llama-server at ${binary.path} is a ${kind} build that did not list its devices within ${timeoutMs / 1000} s, so whether it can use the GPU is unknown.`,
    };
  const help = sycl ? SYCL_HELP : 'To use the GPU, install or update its Vulkan driver (Mesa on Linux).';
  const why = listed.error ? ` (${listed.error.message.split('\n')[0]})` : '';
  return {
    ...binary,
    warning: `llama-server at ${binary.path} is a ${kind} build but lists no GPU${why}, so it runs on the CPU. ${help}`,
  };
}

async function probeBinary(
  path: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  strict: boolean,
  binaryArgs: readonly string[] = []
): Promise<{ path: string; version: string; build: number | null; text: string } | null> {
  const fail = (reason: string) => {
    if (strict) throw new LocalRuntimeError(`llama-server at ${path} ${reason}`, RUNTIME_ID);
    return null;
  };
  try {
    await access(path, constants.X_OK);
  } catch {
    return fail('is missing or not executable');
  }
  const output = await runBinary(path, [...binaryArgs, '--version'], env, timeoutMs);
  const version = /^version:\s*(.+?)\s*$/m.exec(output.text)?.[1];
  if (!version) {
    const sycl = (await gpuBackends(path, '')).has('sycl');
    const missing = missingLibraryError(path, output.text, output.error, sycl);
    if (missing) throw missing;
    return fail(output.error ? `could not run: ${output.error.message}` : 'is not llama-server');
  }
  const build = /\bbuild (\d+)/.exec(version)?.[1] ?? /^(\d+) \(/.exec(version)?.[1];
  return { path, version, build: build ? Number(build) : null, text: output.text };
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
  /**
   * Default `auto`, which builds before b6325 treat as off. A quantized V cache (`-ctv q8_0` in `extraArgs`) needs
   * flash attention, so it turns it on, and `off` with one is refused.
   */
  flashAttention?: LlamaServerFlashAttention;
  /**
   * MiB `--fit` keeps free on each device (llama-server's default is 1024). Passed only to builds from
   * `LLAMA_SERVER_FIT_TARGET_BUILD`; older and unnumbered builds have no `--fit` and run without it.
   */
  fitTargetMiB?: number;
  /** Appended last: flags from `LLAMA_SERVER_TUNING_FLAGS` only, each value as its own argument. */
  extraArgs?: readonly string[];
}

export type LlamaServerFlashAttention = 'auto' | 'on' | 'off';
const FLASH_ATTENTION_MODES: readonly string[] = ['auto', 'on', 'off'] satisfies LlamaServerFlashAttention[];

/** The `-fa` arguments for `tuning` on llama.cpp release `build`; throws for `off` with a quantized V cache. */
export function flashAttentionArgs(tuning: LlamaServerTuning, build: number): string[] {
  const requested = tuning.flashAttention ?? 'auto';
  const extra = tuning.extraArgs ?? [];
  const at = extra.findLastIndex(arg => arg === '-ctv' || arg === '--cache-type-v');
  const cacheType = at === -1 ? undefined : extra[at + 1];
  const quantizedV = cacheType !== undefined && !UNQUANTIZED_CACHE_TYPES.has(cacheType.toLowerCase());
  if (quantizedV && requested === 'off') {
    throw new LocalRuntimeError(
      `a quantized V cache (${extra[at]} ${cacheType}) needs flash attention, so flashAttention cannot be 'off'`,
      RUNTIME_ID
    );
  }
  const mode = quantizedV ? 'on' : requested;
  // `auto` is the default from b6325 and means off before it, so it never needs the flag or the build.
  if (mode === 'auto') return [];
  if (build >= LLAMA_SERVER_FLASH_ATTN_VALUE_BUILD) return ['-fa', mode];
  return mode === 'on' ? ['-fa'] : [];
}

export interface StartLlamaServerOptions extends LlamaServerTuning {
  binaryPath: string;
  /**
   * Placed before llama-server's own arguments, for a `binaryPath` that is a launcher. The launcher must pass the
   * environment through (the key travels in it) and should `exec` llama-server.
   */
  binaryArgs?: readonly string[];
  /** The binary's release from `findLlamaServer`; when unset and flash attention is set, `--version` is run. */
  build?: number;
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

/** For tests: whether the parent-exit hook still holds a process. */
export function trackedLlamaServerCount(): number {
  return trackedChildCount();
}

class ManagedLlamaServer implements LlamaServerProcess {
  readonly exited: Promise<LlamaServerExit>;
  /** Ports named by listening lines, oldest first; a forged line can add one, so each still needs proof. */
  readonly candidates: number[] = [];
  /** When the process said its model loaded, if it has. */
  loadedAt: number | null = null;
  exit: LlamaServerExit | null = null;
  spawnError: Error | null = null;
  onExit: ((exit: LlamaServerExit) => void) | undefined;
  #port = 0;
  #runtime: OpenAICompatibleRuntime | null = null;
  readonly #lines: string[] = [];
  #stopping = false;
  #wake: () => void = () => undefined;
  #changed: Promise<void>;

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
    this.#changed = new Promise(done => (this.#wake = done));
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      createInterface({ input: stream, crlfDelay: Infinity }).on('line', line => {
        this.#lines.push(line);
        if (this.#lines.length > LOG_LINES) this.#lines.shift();
        const match = LISTENING_RE.exec(line);
        const port = Number(match?.[1] ?? match?.[2] ?? 0);
        if (port > 0 && port < 65536 && !this.candidates.includes(port)) {
          this.candidates.push(port);
          this.#notify();
        }
        if (this.loadedAt === null && MODEL_LOADED_RE.test(line)) {
          this.loadedAt = Date.now();
          this.#notify();
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

  #notify(): void {
    this.#wake();
    this.#changed = new Promise(done => (this.#wake = done));
  }

  /** Resolves on the next candidate port or model-loaded line. */
  changed(): Promise<void> {
    return this.#changed;
  }

  get pid(): number {
    return this.child.pid ?? -1;
  }

  get port(): number {
    return this.#port;
  }

  accept(port: number): void {
    this.#port = port;
  }

  get baseUrl(): string {
    return `http://${LOOPBACK}:${this.#port}`;
  }

  /** Whether `/health` on `port` (default the accepted one) answers that it is ready. */
  healthy(port = this.#port, signal?: AbortSignal): Promise<boolean> {
    const client: HttpClient = { runtimeId: RUNTIME_ID, baseUrl: `http://${LOOPBACK}:${port}`, fetch: this.fetchImpl };
    return requestJson(client, '/health', healthSchema, { timeoutMs: HEALTH_REQUEST_TIMEOUT_MS, signal }).then(
      () => true,
      () => false
    );
  }

  /** Whether anything answers HTTP on `port`; `refused` only when the connection itself is refused. */
  async answers(port: number): Promise<'yes' | 'refused' | 'unknown'> {
    try {
      const response = await this.fetchImpl(`http://${LOOPBACK}:${port}/health`, {
        signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => undefined);
      return 'yes';
    } catch (error) {
      const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
      return cause?.code === 'ECONNREFUSED' ? 'refused' : 'unknown';
    }
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

  /** Whether `/props`, asked with this server's key, answers as a router. */
  routes(): Promise<boolean> {
    const client: HttpClient = {
      runtimeId: RUNTIME_ID,
      baseUrl: this.baseUrl,
      fetch: this.fetchImpl,
      headers: { authorization: `Bearer ${this.apiKey}` },
    };
    return requestJson(client, '/props', routerPropsSchema, { timeoutMs: HEALTH_REQUEST_TIMEOUT_MS }).then(
      () => true,
      () => false
    );
  }

  async stop(): Promise<LlamaServerExit> {
    if (this.exit) return this.exit;
    this.#stopping = true;
    return stopTree(this.child, this.exited, this.stopTimeoutMs);
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
  const { contextSize, threads, gpuLayers, flashAttention, fitTargetMiB } = options;
  if (flashAttention !== undefined && !FLASH_ATTENTION_MODES.includes(flashAttention))
    throw new LocalRuntimeError(`flashAttention must be one of ${FLASH_ATTENTION_MODES.join(', ')}`, RUNTIME_ID);
  if (fitTargetMiB !== undefined && !(Number.isInteger(fitTargetMiB) && fitTargetMiB >= 0))
    throw new LocalRuntimeError('fitTargetMiB must be a non-negative integer', RUNTIME_ID);
  if (contextSize !== undefined && !(Number.isInteger(contextSize) && contextSize >= 0))
    throw new LocalRuntimeError('contextSize must be a non-negative integer', RUNTIME_ID);
  if (threads !== undefined && !(Number.isInteger(threads) && threads > 0))
    throw new LocalRuntimeError('threads must be a positive integer', RUNTIME_ID);
  if (gpuLayers !== undefined && !(Number.isInteger(gpuLayers) && gpuLayers >= 0))
    throw new LocalRuntimeError('gpuLayers must be a non-negative integer', RUNTIME_ID);
}

function serverArgs(
  options: StartLlamaServerOptions,
  alias: string,
  contextSize: number,
  buildArgs: string[]
): string[] {
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
    ...buildArgs,
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

/** What `/proc` shows of loopback TCP listeners and of the ones held by a process group (Linux). */
export interface ListenerScan {
  /** False when `/proc/net/tcp` could not be read or listed nothing. */
  tableVisible: boolean;
  /** Ports with a LISTEN socket on 127.0.0.1, each with its `socket:[inode]`. */
  listening: ReadonlyMap<number, string>;
  /** Of those, the ports whose socket a process in the group holds. */
  owned: ReadonlySet<number>;
  /** True when some process of the group hid its file descriptors (a setuid or setcap binary). */
  hidden: boolean;
}

const pgrpOf = async (pid: number) => {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
  // After the parenthesized command name: state, ppid, pgrp.
  return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
};

/**
 * The group's processes among the leader and its descendants; all of `/proc` without `task/<tid>/children`. A
 * member reparented away from the leader is missed here; `socketGroup` catches it.
 */
async function groupProcesses(pgid: number): Promise<number[]> {
  if ((await readFile(`/proc/${pgid}/task/${pgid}/children`, 'utf8').catch(() => null)) === null) {
    const all = (await readdir('/proc').catch(() => [])).filter(name => /^\d+$/.test(name)).map(Number);
    const pgrps = await Promise.all(all.map(pgrpOf));
    return all.filter((_, index) => pgrps[index] === pgid);
  }
  const seen: number[] = [];
  const queue = [pgid];
  while (queue.length > 0 && seen.length < MAX_GROUP_PROCESSES) {
    const pid = queue.shift() as number;
    seen.push(pid);
    for (const tid of await readdir(`/proc/${pid}/task`).catch(() => [])) {
      const children = await readFile(`/proc/${pid}/task/${tid}/children`, 'utf8').catch(() => '');
      queue.push(...children.split(' ').filter(Boolean).map(Number));
    }
  }
  const pgrps = await Promise.all(seen.map(pgrpOf));
  return seen.filter((_, index) => pgrps[index] === pgid);
}

/** Linux only: a model string with a newline in it could print a whole forged listening line. */
async function scanListeners(pgid: number): Promise<ListenerScan> {
  const table = await readFile('/proc/net/tcp', 'utf8').catch(() => '');
  const rows = table.split('\n').slice(1).filter(Boolean);
  const sockets = new Map<string, number>();
  for (const row of rows) {
    const fields = row.trim().split(/\s+/);
    const local = fields[1] ?? '';
    if (local.startsWith('0100007F:') && fields[3] === '0A')
      sockets.set(`socket:[${fields[9]}]`, parseInt(local.slice(9), 16));
  }
  const owned = new Set<number>();
  let hidden = false;
  if (sockets.size > 0) {
    for (const pid of await groupProcesses(pgid)) {
      const fds = await readdir(`/proc/${pid}/fd`).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'EACCES' || error.code === 'EPERM') hidden = true;
        return [];
      });
      for (const fd of fds) {
        const port = sockets.get(await readlink(`/proc/${pid}/fd/${fd}`).catch(() => ''));
        if (port !== undefined) owned.add(port);
      }
    }
  }
  const listening = new Map([...sockets].map(([socket, port]) => [port, socket]));
  return { tableVisible: rows.length > 0, listening, owned, hidden };
}

/** The process group of whichever process holds `socket` (`socket:[inode]`), searching all of `/proc`. */
async function socketGroup(socket: string): Promise<number | null> {
  for (const name of await readdir('/proc').catch(() => [])) {
    if (!/^\d+$/.test(name)) continue;
    for (const fd of await readdir(`/proc/${name}/fd`).catch(() => [])) {
      if ((await readlink(`/proc/${name}/fd/${fd}`).catch(() => '')) === socket) return pgrpOf(Number(name));
    }
  }
  return null;
}

/**
 * The newest candidate held by group `pgid`, or 0. A listening candidate held outside the walked processes gets one
 * full `/proc` search (tracked in `checked`). With `wanted`, a group holding exactly one wanted listener gets it.
 */
async function confirmPort(
  pgid: number,
  candidates: number[],
  scan: ListenerScan,
  checked: Set<number>,
  wanted: ((port: number) => boolean) | null
): Promise<number> {
  const owned = candidates.findLast(candidate => scan.owned.has(candidate));
  if (owned !== undefined) return owned;
  for (const candidate of candidates.toReversed()) {
    const socket = scan.listening.get(candidate);
    if (socket === undefined || checked.has(candidate)) continue;
    checked.add(candidate);
    if ((await socketGroup(socket)) === pgid) return candidate;
  }
  const only = wanted ? [...scan.owned].filter(wanted) : [];
  return only.length === 1 ? only[0] : 0;
}

/** Why `port` cannot be confirmed as the server's, from a scan in which the group does not own it. */
export function listenerProblem(
  port: number,
  scan: ListenerScan
): { reason: LlamaServerStartError['reason']; message: string } {
  if (!scan.tableVisible)
    return {
      reason: 'socket-unreadable',
      message: `cannot read /proc/net/tcp to confirm port ${port} is the server's`,
    };
  if (scan.hidden && scan.listening.has(port)) {
    const message = `cannot see which process holds port ${port}: llama-server hides its file descriptors (setuid or setcap)`;
    return { reason: 'socket-unreadable', message };
  }
  if (!scan.listening.has(port)) {
    const message = `no socket listening on port ${port} is visible; llama-server in another network namespace (a container) is not supported`;
    return { reason: 'other-namespace', message };
  }
  const message = `port ${port} is held by a process outside the llama-server's process group; a launcher must not move it out`;
  return { reason: 'wrong-server', message };
}

const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms).unref());

type LaunchOptions = Pick<StartLlamaServerOptions, 'binaryPath' | 'binaryArgs' | 'build' | 'env' | 'signal'> &
  LlamaServerTuning;

/** The `--fit-target` arguments for `tuning` on llama.cpp release `build`, which is undefined when unnumbered. */
export function fitTargetArgs(tuning: LlamaServerTuning, build: number | undefined): string[] {
  const target = tuning.fitTargetMiB;
  if (target === undefined || build === undefined || build < LLAMA_SERVER_FIT_TARGET_BUILD) return [];
  return ['--fit-target', String(target)];
}

/**
 * The `-fa` and `--fit-target` arguments; throws for `off` with a quantized V cache. Only `on`, `off` and a fit
 * target need the build; an unnumbered build only drops the fit target.
 */
async function buildDependentArgs(options: LaunchOptions): Promise<string[]> {
  const flashAttention = flashAttentionArgs(options, LLAMA_SERVER_FLASH_ATTN_VALUE_BUILD);
  if (flashAttention.length === 0 && options.fitTargetMiB === undefined) return [];
  let build = options.build;
  if (build === undefined) {
    try {
      build = (await findLlamaServer({ path: options.binaryPath, binaryArgs: options.binaryArgs, env: options.env }))
        ?.build;
    } catch (error) {
      const unnumbered = error instanceof LlamaServerVersionError && error.found === null;
      if (!unnumbered || flashAttention.length > 0) throw error;
    }
  }
  options.signal?.throwIfAborted();
  return [...flashAttentionArgs(options, build ?? MIN_LLAMA_SERVER_BUILD), ...fitTargetArgs(options, build)];
}

/** Spawns llama-server with its key in the environment, in its own process group, tracked for the parent's exit. */
function spawnKeyed(options: LaunchOptions, args: string[], apiKey: string): ChildProcess {
  let child: ChildProcess;
  try {
    child = spawn(options.binaryPath, args, {
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
  trackChild(child);
  return child;
}

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
  const buildArgs = await buildDependentArgs(options);

  const apiKey = randomBytes(32).toString('base64url');
  const contextSize = options.contextSize ?? DEFAULT_LLAMA_SERVER_CONTEXT_SIZE;
  const child = spawnKeyed(options, serverArgs(options, alias, contextSize, buildArgs), apiKey);
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

type ReadyOptions = Pick<StartLlamaServerOptions, 'binaryPath' | 'port' | 'startTimeoutMs' | 'signal'>;

async function waitUntilReady(
  server: ManagedLlamaServer,
  options: ReadyOptions,
  aborted: Promise<void>,
  router = false
): Promise<void> {
  const timeoutMs = options.startTimeoutMs;
  const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
  const check = () => {
    options.signal?.throwIfAborted();
    if (!server.running) throw server.exitError(options.binaryPath, options.port);
    if (Date.now() > deadline) throw server.startError('timeout', `llama-server was not ready within ${timeoutMs}ms`);
  };
  const pause = () => Promise.race([delay(HEALTH_POLL_MS), server.exited, aborted, server.changed()]);
  const wanted = (port: number) => options.port === undefined || port === options.port;
  const linux = process.platform === 'linux';
  let scan: ListenerScan | null = null;
  let scannedAt = -Infinity;
  let scannedCandidates = 0;
  const groupChecked = new Set<number>();
  const dropped = new Set<number>();
  // Until a port is confirmed as the process's own, whatever answers there is not known to be it.
  while (server.port === 0) {
    check();
    const candidates = server.candidates.filter(wanted);
    if (linux && (candidates.length > scannedCandidates || Date.now() - scannedAt >= SOCKET_SCAN_MS)) {
      scannedCandidates = candidates.length;
      scannedAt = Date.now();
      scan = await scanListeners(server.pid);
      const settled = server.loadedAt !== null && Date.now() - server.loadedAt >= UNNAMED_PORT_SETTLE_MS;
      server.accept(await confirmPort(server.pid, candidates, scan, groupChecked, settled ? wanted : null));
    } else if (!linux) {
      // The real server binds before it prints its line, so only a refused port can be passed over.
      for (const candidate of candidates.filter(port => !dropped.has(port))) {
        const answer = await server.answers(candidate);
        if (answer === 'refused') dropped.add(candidate);
        else {
          if (answer === 'yes') server.accept(candidate);
          break;
        }
      }
    }
    if (server.port !== 0) break;
    if (server.loadedAt !== null && Date.now() - server.loadedAt > LLAMA_SERVER_PORT_GRACE_MS) {
      const last = candidates.at(-1);
      if (scan && last !== undefined) {
        const problem = listenerProblem(last, scan);
        throw server.startError(problem.reason, problem.message);
      }
      throw server.startError(
        'no-port',
        `llama-server loaded its model but named no port it could be confirmed on within ${LLAMA_SERVER_PORT_GRACE_MS}ms; its listening line may be in a format this version does not know`
      );
    }
    await pause();
  }
  while (true) {
    check();
    if (await server.healthy(server.port, options.signal)) break;
    if (server.loadedAt !== null && Date.now() - server.loadedAt > LLAMA_SERVER_PORT_GRACE_MS) {
      throw server.startError(
        'no-port',
        `llama-server loaded its model but port ${server.port} did not answer /health within ${LLAMA_SERVER_PORT_GRACE_MS}ms`
      );
    }
    await pause();
  }
  const status = await server.statusWithoutKey('/props');
  if (status !== 401) {
    throw server.startError(
      'unauthenticated',
      `llama-server answered /props without its API key (${status ?? 'no answer'}); a launcher must pass LLAMA_API_KEY through`
    );
  }
  if (!(await (router ? server.routes() : server.serves())))
    throw server.startError('wrong-server', `port ${server.port} answered, but not as the llama-server just started`);
  check();
}

export interface StartLlamaRouterOptions extends Pick<
  LlamaServerTuning,
  'flashAttention' | 'fitTargetMiB' | 'extraArgs'
> {
  binaryPath: string;
  /** As for `startLlamaServer`. */
  binaryArgs?: readonly string[];
  build?: number;
  /** The GGUF files it serves, each loaded on its first request. */
  modelsDir: string;
  /** The loopback port it listens on. */
  port: number;
  /** How many models it keeps loaded at once (`--models-max`); default llama-server's. */
  modelsMax?: number;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  signal?: AbortSignal;
  onLog?: (line: string) => void;
  onExit?: (exit: LlamaServerExit) => void;
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
}

/** A llama-server in router mode: one address for every model in `modelsDir`, each run by a server it starts. */
export interface LlamaRouterProcess {
  readonly pid: number;
  /** `http://127.0.0.1:<port>`; the OpenAI API is under `/v1`. */
  readonly baseUrl: string;
  readonly port: number;
  /** Per-process key, required on every request except `/health`. */
  readonly apiKey: string;
  readonly modelsDir: string;
  readonly exited: Promise<LlamaServerExit>;
  readonly running: boolean;
  log(): string[];
  stop(): Promise<LlamaServerExit>;
}

/**
 * Starts llama-server in router mode on a fixed loopback port with a fresh API key, as `startLlamaServer` starts one
 * model. The flags apply to every model it loads. Resolves once its port is confirmed, `/health` answers and `/props`
 * answers as a router only with the key. Needs a llama.cpp build with router mode (`--models-dir`).
 */
export async function startLlamaRouter(options: StartLlamaRouterOptions): Promise<LlamaRouterProcess> {
  options.signal?.throwIfAborted();
  assertBinaryPath(options.binaryPath);
  assertTuning(options);
  if (!(Number.isInteger(options.port) && options.port > 0 && options.port < 65536))
    throw new LocalRuntimeError('port must be an integer from 1 to 65535', RUNTIME_ID);
  if (options.modelsMax !== undefined && !(Number.isInteger(options.modelsMax) && options.modelsMax >= 0))
    throw new LocalRuntimeError('modelsMax must be a non-negative integer', RUNTIME_ID);
  const dir = await stat(options.modelsDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw storageError(RUNTIME_ID, options.modelsDir, error, 'read');
  });
  if (!dir?.isDirectory()) throw new LocalRuntimeError(`${options.modelsDir} is not a folder`, RUNTIME_ID);
  const buildArgs = await buildDependentArgs(options);

  const apiKey = randomBytes(32).toString('base64url');
  const args = [
    ...(options.binaryArgs ?? []),
    '--models-dir',
    options.modelsDir,
    '--host',
    LOOPBACK,
    '--port',
    String(options.port),
    ...(options.modelsMax === undefined ? [] : ['--models-max', String(options.modelsMax)]),
    '--jinja',
    '--no-webui',
    '--offline',
    ...buildArgs,
    ...(options.extraArgs ?? []),
  ];
  const child = spawnKeyed(options, args, apiKey);
  const server = new ManagedLlamaServer(
    child,
    apiKey,
    '',
    options.modelsDir,
    0,
    options.stopTimeoutMs ?? DEFAULT_LLAMA_SERVER_STOP_TIMEOUT_MS,
    options.fetch ?? fetch,
    options.onLog
  );
  const aborted = untilAborted(options.signal);
  try {
    await waitUntilReady(server, options, aborted.promise, true);
    options.signal?.throwIfAborted();
    server.onExit = options.onExit;
  } catch (error) {
    await server.stop();
    options.signal?.throwIfAborted();
    if (error instanceof LlamaServerExitError && error.log.some(line => NO_ROUTER_RE.test(line))) {
      const message = `llama-server at ${options.binaryPath} has no router mode (--models-dir); a newer llama.cpp build is needed`;
      throw new LlamaServerExitError(message, error.code, error.signal, false, error.log, { cause: error });
    }
    throw error;
  } finally {
    aborted.dispose();
  }
  const modelsDir = options.modelsDir;
  return {
    get pid() {
      return server.pid;
    },
    baseUrl: server.baseUrl,
    port: server.port,
    apiKey,
    modelsDir,
    exited: server.exited,
    get running() {
      return server.running;
    },
    log: () => server.log(),
    stop: () => server.stop(),
  };
}

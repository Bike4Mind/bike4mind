import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  CALLABLE_FUNCTION_CALL_OUTCOMES,
  FUNCTION_CONTRACT_LIMITS,
  FUNCTION_RESULT_TOO_LARGE_PREFIX,
  PYODIDE_VERSION,
  canonicalJson,
  functionCallGluePy,
  functionJsonBytes,
  parseFunctionContract,
  validateFunctionValue,
  type CallableFunctionCallOutcome,
  type FunctionContract,
  type FunctionContractProblem,
} from '@bike4mind/common';
import {
  CALLABLE_FUNCTION_DEFAULT_TIMEOUT_MS,
  CALLABLE_FUNCTION_LIMITS,
  CALLABLE_FUNCTION_START_BUDGET_MS,
  runTimeoutAfterDownload,
  type CallableFunctionLimits,
} from './runtimeLimits';
import {
  CALLABLE_FUNCTION_DATA_DOWNLOAD_BUDGET_MS,
  prepareRunData,
  validRunData,
  type CallableFunctionRunData,
  type DataFetch,
} from './runtimeData';

/**
 * The parent half of the server runtime for Python functions: one fresh child process per run,
 * spawned with an empty environment and killed at the timeout and after every run. The child is
 * `apps/workers/src/callableFunctions/child.ts`; the Lambda entry is `handler.ts` beside it.
 */

/** Path of `child.ts` (or its build). */
export const CALLABLE_FUNCTION_CHILD_PATH_ENV = 'CALLABLE_FUNCTION_CHILD_PATH';
/** Directory holding pyodide.mjs, the rest of the Pyodide core, pyodide-lock.json and the package wheels. */
export const CALLABLE_FUNCTION_PYODIDE_DIR_ENV = 'CALLABLE_FUNCTION_PYODIDE_DIR';

export * from './runtimeLimits';

const CALL_LIMIT_KEYS = ['timeoutMs', 'inputBytes', 'outputBytes'] as const;
type CallLimitKey = (typeof CALL_LIMIT_KEYS)[number];

/** Limits one call asks for; each must be a positive whole number no higher than the runtime's ceiling. */
export type CallableFunctionCallLimits = Partial<Pick<CallableFunctionLimits, CallLimitKey>>;

export const CALLABLE_FUNCTION_OUTCOMES = CALLABLE_FUNCTION_CALL_OUTCOMES;
export type CallableFunctionOutcome = CallableFunctionCallOutcome;

/** Fixed codes only: nothing the guest prints or raises is returned as text, except `printed`. */
export const CALLABLE_FUNCTION_REASONS = [
  'payload_invalid',
  'source_too_large',
  'contract_invalid',
  'contract_changed',
  'input_too_large',
  'runtime_unavailable',
  'pyodide_version',
  'no_reply',
  'reply_too_large',
  'contract_missing',
  'contract_not_json',
  'contract_too_large',
  'run_missing',
  'run_async',
  'result_not_dict',
  'result_not_json',
  'result_too_large',
  'limit_above_ceiling',
  'start_timeout',
  'data_unavailable',
  'data_hash_mismatch',
] as const;
export type CallableFunctionReason = (typeof CALLABLE_FUNCTION_REASONS)[number];

export type CallableFunctionRunPayload =
  | { op: 'read_contract'; code: string; limits?: CallableFunctionCallLimits }
  | {
      op: 'call';
      code: string;
      contract: FunctionContract;
      params: Record<string, unknown>;
      limits?: CallableFunctionCallLimits;
      /** Links signed for this call, never the bytes. */
      data?: CallableFunctionRunData[];
    };

export interface CallableFunctionRunResult {
  outcome: CallableFunctionOutcome;
  reason?: CallableFunctionReason;
  /** The guest exception's class name, never its message. */
  errorClass?: string;
  /** Inline outputs. An output stored elsewhere would get a sibling field, so do not assume every output is here. */
  outputs?: Record<string, unknown>;
  /** Filled by the dispatcher; the runtime never sets it. */
  stamp?: Record<string, unknown>;
  contract?: FunctionContract;
  problems?: FunctionContractProblem[];
  printed?: string;
  durationMs: number;
  initMs?: number;
  /** Spawn to run start, outside the time limit. */
  startMs?: number;
  /** What the run loaded, for the stamp; set once the child replied. */
  runtime?: CallableFunctionRuntimeReport;
}

export interface CallableFunctionRuntimeReport {
  /** sha256 of the runtime's `pyodide-lock.json`. */
  lockHash: string;
  /** Sorted by name; versions from the lock file. */
  packages: { name: string; version: string }[];
}

/** One request line on the child's stdin. */
export interface CallableFunctionChildRequest {
  op: 'read_contract' | 'call';
  glue: string;
  code: string;
  paramsJson: string | null;
  pyodideVersion: string;
  /** The call's read-only data directory, mounted at `/data`; null when it has no data files. */
  dataDir: string | null;
}

/** One reply line on the child's stdout. Its strings come from guest code and are checked here. */
export type CallableFunctionChildReply =
  | {
      ok: true;
      initMs: number;
      contractJson?: string;
      outputsJson?: string;
      outputProblemsJson?: string;
      printed: string;
      error?: string;
      /** The exception's class name from its type, not parsed out of the traceback text. */
      errorClass?: string;
      /** Pyodide's loaded package names, read before guest code ran. */
      packages?: string[];
    }
  | { ok: false; failure: 'request' | 'load' | 'version' };

/**
 * The child's line just before guest code first runs, written by the child itself: the guest's stdout
 * never reaches the pipe. The time limit starts when the first one arrives; a repeat never restarts it.
 */
export interface CallableFunctionChildRunStarted {
  started: true;
}

export interface CallableFunctionChildOptions {
  childPath: string;
  pyodideDir: string;
  /** Lowers this host's ceilings (tests); a call's own `limits` are checked against the result. */
  limits?: Partial<CallableFunctionLimits>;
  startBudgetMs?: number;
  nodePath?: string;
  /** Where data files are cached between calls; a directory under the OS temp directory by default. */
  dataCacheDir?: string;
  fetchData?: DataFetch;
}

// The outputs and the contract travel as JSON strings inside the reply, so escaping can double them; a
// printed or error character can take six bytes as a \u escape (stdout, stderr, and the error, each capped).
const REPLY_ENVELOPE_BYTES = 64 * 1024;
/** Bounds the child's stdout pipe, not the Lambda's reply, which the result's own caps keep under 6 MB. */
export const CALLABLE_FUNCTION_MAX_REPLY_BYTES =
  2 * (CALLABLE_FUNCTION_LIMITS.outputBytes + FUNCTION_CONTRACT_LIMITS.maxContractBytes) +
  6 * 3 * CALLABLE_FUNCTION_LIMITS.printedChars +
  REPLY_ENVELOPE_BYTES;
const MEMORY_POLL_MS = 100;

/** The node flags every child runs under; the test-only child switches are never among them. */
export function callableFunctionChildArgs(
  childPath: string,
  pyodideDir: string,
  memoryMb: number,
  dataDir: string | null = null
): string[] {
  return [
    '--permission',
    `--allow-fs-read=${childPath}`,
    `--allow-fs-read=${pyodideDir}`,
    // Read only: no --allow-fs-write, so the guest cannot change or add a file under /data.
    ...(dataDir ? [`--allow-fs-read=${dataDir}`] : []),
    '--disallow-code-generation-from-strings',
    `--max-old-space-size=${memoryMb}`,
    childPath,
    pyodideDir,
  ];
}

const live = new Set<number>();

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

/** Kills any child process group a run left behind; returns how many it found. */
export function sweepCallableFunctionChildren(): number {
  let found = 0;
  for (const pid of live) {
    if (groupAlive(pid)) {
      found++;
      killGroup(pid);
    }
    live.delete(pid);
  }
  return found;
}

/** The pids of child groups a run has not yet confirmed gone (empty between runs). */
export function liveCallableFunctionChildren(): number[] {
  return [...live];
}

interface ChildRun {
  kind: 'reply' | 'timeout' | 'start_timeout' | 'memory' | 'reply_too_large' | 'no_reply' | 'spawn_failed';
  reply?: unknown;
  startMs?: number;
}

const execFileAsync = promisify(execFile);
const PS_TIMEOUT_MS = 1000;

// /proc where it exists; `ps` elsewhere (macOS), which also covers the in-process runner in development.
async function residentMb(pid: number): Promise<number | null> {
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
    return match ? Number(match[1]) / 1024 : null;
  } catch {
    // Fall through to ps.
  }
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: PS_TIMEOUT_MS });
    const kb = Number(stdout.trim());
    return Number.isFinite(kb) && kb > 0 ? kb / 1024 : null;
  } catch {
    return null;
  }
}

async function runChild(
  request: CallableFunctionChildRequest,
  options: CallableFunctionChildOptions,
  limits: CallableFunctionLimits
): Promise<ChildRun> {
  let childPath: string;
  let pyodideDir: string;
  try {
    childPath = realpathSync(options.childPath);
    pyodideDir = realpathSync(options.pyodideDir);
  } catch {
    return { kind: 'spawn_failed' };
  }
  const child = spawn(
    options.nodePath ?? process.execPath,
    callableFunctionChildArgs(childPath, pyodideDir, limits.memoryMb, request.dataDir),
    {
      // Empty on purpose; the assertion only satisfies Next's ProcessEnv, which makes NODE_ENV required.
      env: {} as NodeJS.ProcessEnv,
      cwd: pyodideDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group, so the kill reaches anything it started.
      detached: true,
    }
  );
  const pid = child.pid;
  if (pid === undefined) {
    child.on('error', () => {});
    return { kind: 'spawn_failed' };
  }
  live.add(pid);

  const exited = new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', () => resolve());
  });
  const spawnedAt = Date.now();
  let startMs: number | undefined;
  let done = false;
  let resolveRun: (run: ChildRun) => void = () => {};
  const settled = new Promise<ChildRun>(resolve => {
    resolveRun = resolve;
  });
  const settle = (run: Omit<ChildRun, 'startMs'>) => {
    done = true;
    resolveRun({ ...run, startMs });
  };

  const startBudgetMs = options.startBudgetMs ?? CALLABLE_FUNCTION_START_BUDGET_MS;
  let timer = setTimeout(() => settle({ kind: 'start_timeout' }), startBudgetMs);
  const onLine = (line: string) => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return settle({ kind: 'no_reply' });
    }
    const runStarted = isObject(message) && message.started === true;
    if (startMs === undefined) {
      if (runStarted) {
        startMs = Date.now() - spawnedAt;
        clearTimeout(timer);
        timer = setTimeout(() => settle({ kind: 'timeout' }), limits.timeoutMs);
        return;
      }
      // Before the run starts, only a start failure can come back.
      const failed = isObject(message) && message.ok === false;
      return settle(failed ? { kind: 'reply', reply: message } : { kind: 'no_reply' });
    }
    if (runStarted) return;
    settle(isObject(message) && message.ok === true ? { kind: 'reply', reply: message } : { kind: 'no_reply' });
  };

  let pending: Buffer[] = [];
  let replyBytes = 0;
  child.stdout.on('data', (chunk: Buffer) => {
    if (done) return;
    replyBytes += chunk.length;
    if (replyBytes > CALLABLE_FUNCTION_MAX_REPLY_BYTES) return settle({ kind: 'reply_too_large' });
    let rest = chunk;
    for (let newline = rest.indexOf(0x0a); newline >= 0 && !done; newline = rest.indexOf(0x0a)) {
      onLine(Buffer.concat([...pending, rest.subarray(0, newline)]).toString('utf8'));
      pending = [];
      rest = rest.subarray(newline + 1);
    }
    if (rest.length > 0) pending.push(rest);
  });
  // Drained and dropped: nothing the child writes to stderr leaves this function.
  child.stderr.resume();
  child.stdin.on('error', () => {});
  child.on('error', () => settle({ kind: 'spawn_failed' }));
  // 'close' rather than 'exit': stdout can still hold the reply when the process has exited.
  child.once('close', () => settle({ kind: 'no_reply' }));

  const memoryTimer = setInterval(() => {
    void residentMb(pid).then(mb => {
      if (mb !== null && mb > limits.memoryMb) settle({ kind: 'memory' });
    });
  }, MEMORY_POLL_MS);

  child.stdin.end(`${JSON.stringify(request)}\n`);
  const run = await settled;
  clearTimeout(timer);
  clearInterval(memoryTimer);

  killGroup(pid);
  // 'exit' fires only once Node has reaped the child; until then a group probe still finds it as a zombie.
  await exited;
  // Only another member of its group can answer now: kill it and leave the pid to the sweep.
  if (groupAlive(pid)) killGroup(pid);
  else live.delete(pid);
  return run;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const optionalString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

function parseReply(raw: unknown): CallableFunctionChildReply | null {
  if (!isObject(raw)) return null;
  if (raw.ok === false) {
    return raw.failure === 'request' || raw.failure === 'load' || raw.failure === 'version'
      ? { ok: false, failure: raw.failure }
      : null;
  }
  if (raw.ok !== true || typeof raw.printed !== 'string') return null;
  return {
    ok: true,
    initMs: typeof raw.initMs === 'number' ? raw.initMs : 0,
    contractJson: optionalString(raw.contractJson),
    outputsJson: optionalString(raw.outputsJson),
    outputProblemsJson: optionalString(raw.outputProblemsJson),
    printed: raw.printed,
    error: optionalString(raw.error),
    errorClass: optionalString(raw.errorClass),
    packages: Array.isArray(raw.packages)
      ? raw.packages
          .filter((name): name is string => typeof name === 'string' && PACKAGE_NAME.test(name))
          .slice(0, MAX_PACKAGES)
      : [],
  };
}

const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const MAX_PACKAGES = 200;

interface PyodideLock {
  lockHash: string;
  versions: Map<string, string>;
}

const locks = new Map<string, Promise<PyodideLock | null>>();

async function readPyodideLock(pyodideDir: string): Promise<PyodideLock | null> {
  try {
    const bytes = await readFile(path.join(pyodideDir, 'pyodide-lock.json'));
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    const packages = isObject(parsed) && isObject(parsed.packages) ? parsed.packages : {};
    const versions = new Map<string, string>();
    for (const [name, entry] of Object.entries(packages)) {
      if (isObject(entry) && typeof entry.version === 'string') versions.set(name, entry.version);
    }
    return { lockHash: createHash('sha256').update(bytes).digest('hex'), versions };
  } catch {
    return null;
  }
}

/** The lock file's hash and the versions of the packages the child loaded; null when the lock is unreadable. */
async function runtimeReport(pyodideDir: string, names: string[]): Promise<CallableFunctionRuntimeReport | null> {
  let pending = locks.get(pyodideDir);
  if (!pending) {
    pending = readPyodideLock(pyodideDir);
    locks.set(pyodideDir, pending);
  }
  const lock = await pending;
  if (!lock) {
    locks.delete(pyodideDir);
    return null;
  }
  const packages = [...new Set(names)].sort().flatMap(name => {
    const version = lock.versions.get(name);
    return version === undefined ? [] : [{ name, version }];
  });
  return { lockHash: lock.lockHash, packages };
}

const CHILD_FAILURES = {
  request: 'payload_invalid',
  load: 'runtime_unavailable',
  version: 'pyodide_version',
} as const satisfies Record<string, CallableFunctionReason>;

const GLUE_REFUSALS: ReadonlyArray<[string, CallableFunctionReason]> = [
  ['FUNCTION is not defined', 'contract_missing'],
  ['FUNCTION is not valid JSON', 'contract_not_json'],
  ['The function contract is larger than', 'contract_too_large'],
  ['run is not defined as a function', 'run_missing'],
  ['run must be defined with def', 'run_async'],
  ['run must return a dict', 'result_not_dict'],
  ['run returned a value that is not valid JSON', 'result_not_json'],
  [FUNCTION_RESULT_TOO_LARGE_PREFIX, 'result_too_large'],
];

/** The call log's `errorClass` pattern (`CallableFunctionCallModel`); a remote reply is held to it too. */
export const CALLABLE_FUNCTION_ERROR_CLASS = /^[A-Za-z_][A-Za-z0-9_.]{0,99}$/;

/** Reduces guest error text to a class name and, for the glue's own refusals, a fixed reason. */
export function classifyGuestError(
  error: string,
  errorClass?: string
): { errorClass: string; reason?: CallableFunctionReason } {
  if (!error.startsWith('Traceback (most recent call last):')) {
    const refusal = GLUE_REFUSALS.find(([prefix]) => error.startsWith(prefix));
    return { errorClass: 'FunctionCallError', reason: refusal?.[1] };
  }
  return {
    errorClass: errorClass !== undefined && CALLABLE_FUNCTION_ERROR_CLASS.test(errorClass) ? errorClass : 'Exception',
  };
}

const PROBLEM_PATH = /^[A-Za-z0-9_.]{0,200}$/;
const PYTHON_TYPE_MESSAGES = new Set(['must be a number', 'must be a whole number']);

/** Problems the guest's process reported; anything outside the glue's fixed shape is dropped. */
function pythonTypeProblems(json: string | undefined): FunctionContractProblem[] {
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is FunctionContractProblem =>
        isObject(item) &&
        typeof item.path === 'string' &&
        PROBLEM_PATH.test(item.path) &&
        typeof item.message === 'string' &&
        PYTHON_TYPE_MESSAGES.has(item.message)
    )
    .slice(0, FUNCTION_CONTRACT_LIMITS.maxProblems)
    .map(({ path, message }) => ({ path, message }));
}

/** Value problems keep fixed messages, but a path can name a key the guest returned. */
const safePaths = (problems: FunctionContractProblem[]): FunctionContractProblem[] =>
  problems.map(problem => (PROBLEM_PATH.test(problem.path) ? problem : { ...problem, path: '(unlisted key)' }));

const PAYLOAD_KEYS = {
  read_contract: ['op', 'code', 'limits'],
  call: ['op', 'code', 'contract', 'params', 'limits', 'data'],
} as const;

// Only the known keys, so the caps on each one bound the whole request (Lambda takes at most 6 MB).
function validPayload(payload: unknown): payload is CallableFunctionRunPayload {
  if (!isObject(payload) || typeof payload.code !== 'string') return false;
  if (payload.op !== 'read_contract' && payload.op !== 'call') return false;
  const keys: readonly string[] = PAYLOAD_KEYS[payload.op];
  if (!Object.keys(payload).every(key => keys.includes(key))) return false;
  if (payload.data !== undefined && !validRunData(payload.data)) return false;
  return payload.op === 'read_contract' || (isObject(payload.params) && payload.contract !== undefined);
}

const isCallLimitKey = (key: string): key is CallLimitKey => (CALL_LIMIT_KEYS as readonly string[]).includes(key);

/** A call's limits over the ceilings, or why they are refused. */
function callLimits(
  requested: unknown,
  ceilings: CallableFunctionLimits
): CallableFunctionLimits | CallableFunctionReason {
  const limits = { ...ceilings, timeoutMs: Math.min(CALLABLE_FUNCTION_DEFAULT_TIMEOUT_MS, ceilings.timeoutMs) };
  if (requested === undefined) return limits;
  if (!isObject(requested)) return 'payload_invalid';
  for (const [key, value] of Object.entries(requested)) {
    if (!isCallLimitKey(key) || typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      return 'payload_invalid';
    }
    if (value > ceilings[key]) return 'limit_above_ceiling';
    limits[key] = value;
  }
  return limits;
}

/** Runs one operation in a fresh child and checks everything it returns. */
export async function runCallableFunctionInChild(
  payload: unknown,
  options: CallableFunctionChildOptions
): Promise<CallableFunctionRunResult> {
  const started = Date.now();
  const child: { startMs?: number } = {};
  const finish = (result: Omit<CallableFunctionRunResult, 'durationMs'>): CallableFunctionRunResult => ({
    ...result,
    ...(child.startMs === undefined ? {} : { startMs: child.startMs }),
    durationMs: Date.now() - started,
  });
  const refused = (reason: CallableFunctionReason) => finish({ outcome: 'refused', reason });

  if (!validPayload(payload)) return refused('payload_invalid');
  const ceilings = { ...CALLABLE_FUNCTION_LIMITS, ...options.limits };
  const limits = callLimits(payload.limits, ceilings);
  if (typeof limits === 'string') return refused(limits);
  // Counted as it travels in the request, escapes included.
  if (functionJsonBytes(JSON.stringify(payload.code)) > limits.sourceBytes) return refused('source_too_large');

  let pinned: FunctionContract | undefined;
  let paramsJson: string | null = null;
  if (payload.op === 'call') {
    const parsed = parseFunctionContract(payload.contract);
    if (!parsed.ok) return refused('contract_invalid');
    pinned = parsed.contract;
    paramsJson = JSON.stringify(payload.params);
    if (functionJsonBytes(paramsJson) > limits.inputBytes) {
      return finish({ outcome: 'input_invalid', reason: 'input_too_large' });
    }
    const problems = validateFunctionValue(pinned.inputs, payload.params);
    if (problems.length > 0) return finish({ outcome: 'input_invalid', problems });
  }

  const downloadStarted = Date.now();
  const downloadBudgetMs = Math.min(CALLABLE_FUNCTION_DATA_DOWNLOAD_BUDGET_MS, limits.timeoutMs);
  const data = await prepareRunData(payload.op === 'call' ? payload.data : undefined, {
    cacheDir: options.dataCacheDir,
    fetchData: options.fetchData,
    budgetMs: downloadBudgetMs,
  });
  if (!data.ok) {
    if (data.reason === 'data_hash_mismatch') return finish({ outcome: 'data_mismatch', reason: data.reason });
    // The call's own time ran out while downloading: a timeout, ended inside the caller's wait.
    if (Date.now() - downloadStarted >= limits.timeoutMs) return finish({ outcome: 'timeout' });
    return finish({ outcome: 'error', reason: data.reason });
  }
  const timeoutMs = runTimeoutAfterDownload(limits.timeoutMs, Date.now() - downloadStarted);
  if (timeoutMs === 0) {
    await data.release();
    return finish({ outcome: 'timeout' });
  }
  let run: ChildRun;
  try {
    run = await runChild(
      {
        op: payload.op,
        glue: functionCallGluePy(limits.outputBytes),
        code: payload.code,
        paramsJson,
        pyodideVersion: PYODIDE_VERSION,
        dataDir: data.dir,
      },
      options,
      { ...limits, timeoutMs }
    );
  } finally {
    await data.release();
  }
  child.startMs = run.startMs;
  if (run.kind === 'spawn_failed') return refused('runtime_unavailable');
  // The lock is the parent's own file, so an outcome with no reply still names it; packages need the reply.
  const lockOnly = await runtimeReport(options.pyodideDir, []);
  const noReply = lockOnly ? { runtime: lockOnly } : {};
  // Never `timeout`: a slow start is the runtime's, not the function's.
  if (run.kind === 'start_timeout') return finish({ ...noReply, outcome: 'error', reason: 'start_timeout' });
  if (run.kind === 'timeout') return finish({ ...noReply, outcome: 'timeout' });
  if (run.kind === 'memory') return finish({ ...noReply, outcome: 'memory' });
  if (run.kind === 'reply_too_large') {
    return finish({ ...noReply, outcome: 'output_too_large', reason: 'reply_too_large' });
  }
  const reply = run.kind === 'reply' ? parseReply(run.reply) : null;
  if (!reply) return finish({ ...noReply, outcome: 'error', reason: 'no_reply' });
  if (!reply.ok) return refused(CHILD_FAILURES[reply.failure]);

  const report = await runtimeReport(options.pyodideDir, reply.packages ?? []);
  const after = {
    initMs: reply.initMs,
    printed: reply.printed.slice(0, limits.printedChars),
    ...(report ? { runtime: report } : {}),
  };
  if (reply.error !== undefined) {
    const { errorClass, reason } = classifyGuestError(reply.error, reply.errorClass);
    if (reason === 'result_too_large') return finish({ ...after, outcome: 'output_too_large', reason });
    if (errorClass === 'MemoryError') return finish({ ...after, outcome: 'memory', errorClass });
    return finish({ ...after, outcome: 'error', errorClass, reason });
  }

  let contractRaw: unknown;
  try {
    contractRaw = JSON.parse(reply.contractJson ?? '');
  } catch {
    return finish({ ...after, outcome: 'output_invalid', reason: 'contract_not_json' });
  }
  const read = parseFunctionContract(contractRaw);
  if (payload.op === 'read_contract') {
    return read.ok
      ? finish({ ...after, outcome: 'ok', contract: read.contract })
      : finish({ ...after, outcome: 'output_invalid', reason: 'contract_invalid', problems: safePaths(read.problems) });
  }
  // Key-sorted JSON: key order does not count, and -0 reads as 0, as the browser saves it.
  if (!pinned || !read.ok || canonicalJson(read.contract) !== canonicalJson(pinned)) {
    return refused('contract_changed');
  }

  const outputsJson = reply.outputsJson ?? '';
  if (functionJsonBytes(outputsJson) > limits.outputBytes) {
    return finish({ ...after, outcome: 'output_too_large', reason: 'result_too_large' });
  }
  let outputs: unknown;
  try {
    outputs = JSON.parse(outputsJson);
  } catch {
    return finish({ ...after, outcome: 'output_invalid', reason: 'result_not_json' });
  }
  // Measured again as the result carries it: Python writes 1e+20 where JSON.stringify writes 21 digits.
  if (functionJsonBytes(JSON.stringify(outputs)) > limits.outputBytes) {
    return finish({ ...after, outcome: 'output_too_large', reason: 'result_too_large' });
  }
  const problems = [...pythonTypeProblems(reply.outputProblemsJson), ...validateFunctionValue(pinned.outputs, outputs)];
  if (problems.length > 0 || !isObject(outputs)) {
    return finish({ ...after, outcome: 'output_invalid', problems: safePaths(problems) });
  }
  return finish({ ...after, outcome: 'ok', outputs });
}

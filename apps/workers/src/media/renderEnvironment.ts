import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * Per-render hygiene for the publish-thumbnail renderer (publishThumbnailRenderer.ts): a render
 * starts with no process and no file left over from an earlier one, gets a browser profile and
 * temp directory of its own, and is torn down and checked before its result is released.
 *
 *  - before: refuse unless the process table holds nothing but this runtime, its ancestors and
 *    the sandbox's init (PID 1), then empty the scratch root. On Lambda that is /tmp, which
 *    outlives even an environment reset, and where @sparticuz/chromium reuses an
 *    already-extracted browser rather than extracting it again from the deployment package;
 *  - during: the render gets a fresh workspace (profile + temp dir) under the scratch root;
 *  - after: SIGKILL every remaining descendant of this runtime by PID, check the table again,
 *    and empty the scratch root.
 *
 * A failed check poisons the environment: that render throws RenderEnvironmentError (the
 * orchestrator lets SQS retry it) and every later run is refused. Processes that are not
 * descendants of this runtime are never signalled, only reported. lambdaRuntimeExit.ts then
 * retires the runtime after every invocation regardless.
 *
 * If Lambda itself ends the invocation at its timeout, this teardown never runs, and a process the
 * render left behind makes the before-check refuse every later render in that execution
 * environment until Lambda retires it. A run therefore takes a deadline and stops waiting for the
 * render early enough that its own teardown always finishes first.
 */

/** One process as listed by a ProcessTable. */
export interface ProcessEntry {
  pid: number;
  ppid: number;
  /** One-letter state as in /proc/<pid>/stat; Z and X have exited and can no longer run. */
  state: string;
  /** Short command name, for error messages only. */
  name: string;
  /** Kernel threads belong to the kernel, not to anything a render started. */
  kernelThread: boolean;
}

export interface ProcessTable {
  /** Every process visible to this runtime, including itself. */
  list(): Promise<ProcessEntry[]>;
  /** SIGKILL one process by PID; one that is already gone is not an error. */
  kill(pid: number): void;
}

export interface RenderWorkspace {
  /** Empty browser profile directory, used for this render only. */
  userDataDir: string;
  /** Empty directory for the browser's HOME and TMPDIR, used for this render only. */
  tmpDir: string;
}

export interface RunOptions {
  /**
   * Epoch ms by which the run must have returned, teardown included. A render still going when
   * only the teardown's time is left fails with RenderDeadlineError, and its processes are killed.
   */
  deadline?: number;
}

export interface RenderEnvironment {
  /** Runs one render between the checks above; its result is released only if teardown verifies. */
  run<T>(render: (workspace: RenderWorkspace) => Promise<T>, options?: RunOptions): Promise<T>;
}

export interface RenderEnvironmentOptions {
  /** Directory emptied before and after every render; the Lambda passes /tmp. */
  scratchRoot: string;
  processes: ProcessTable;
  /** The runtime whose descendants are the render's processes; this process by default. */
  selfPid?: number;
  /** How long the teardown keeps killing descendants before giving up (ms). */
  killTimeoutMs?: number;
}

/** The render could not be shown to start or finish clean; nothing it produced is returned. */
export class RenderEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderEnvironmentError';
  }
}

/** The render ran out of the time its invocation had left; retryable, and the environment stays usable. */
export class RenderDeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderDeadlineError';
  }
}

const KILL_TIMEOUT_MS = 5_000;
/** Teardown time beyond the kill loop: two /proc scans and emptying the scratch root (ms). */
const TEARDOWN_MARGIN_MS = 3_000;
const KILL_POLL_MS = 50;
const EXITED_STATES = new Set(['Z', 'X', 'x']);
const INIT_PID = 1;
const WORKSPACE_PREFIX = 'thumbnail-render-';

export function createRenderEnvironment({
  scratchRoot,
  processes,
  selfPid = process.pid,
  killTimeoutMs = KILL_TIMEOUT_MS,
}: RenderEnvironmentOptions): RenderEnvironment {
  let poisonedBy: string | undefined;
  let busy = false;

  const poison = (problems: string[]): RenderEnvironmentError => {
    poisonedBy ??= problems.join('; ');
    console.error(`publish thumbnail render environment failed its check: ${problems.join('; ')}`);
    return new RenderEnvironmentError(`render environment is not clean: ${problems.join('; ')}`);
  };

  const strayProcessProblem = async (): Promise<string | undefined> => {
    const entries = await processes.list();
    const stray = strayProcesses(entries, selfPid);
    if (stray?.length === 0) return undefined;
    // The whole table, so a refusal on real Lambda can be diagnosed from the logs alone.
    console.error(`publish thumbnail render process table (self ${selfPid}): ${describeTable(entries)}`);
    if (stray === undefined) return 'the process table does not list this runtime';
    return `unexpected processes ${describe(stray)}`;
  };

  const scratchProblem = async (): Promise<string | undefined> => {
    const left = await emptyDirectory(scratchRoot);
    return left.length ? `could not empty the scratch directory (${left.length} entries left)` : undefined;
  };

  const killDescendants = async (): Promise<string | undefined> => {
    const deadline = Date.now() + killTimeoutMs;
    for (;;) {
      const victims = liveDescendants(await processes.list(), selfPid);
      if (victims.length === 0) return undefined;
      if (Date.now() >= deadline) return `render processes survived SIGKILL ${describe(victims)}`;
      for (const victim of victims) processes.kill(victim.pid);
      await sleep(KILL_POLL_MS);
    }
  };

  return {
    async run<T>(render: (workspace: RenderWorkspace) => Promise<T>, { deadline }: RunOptions = {}): Promise<T> {
      if (poisonedBy) throw new RenderEnvironmentError(`render environment already failed a check: ${poisonedBy}`);
      if (busy) throw new RenderEnvironmentError('a render is already running in this environment');
      busy = true;
      try {
        // Processes first: a live leftover could refill the directory right after it is emptied.
        // This order is also what keeps a shared host's scratch root intact: `sst dev` runs this
        // handler locally with AWS_LAMBDA_RUNTIME_API set, and a shared process table (or a host
        // with no /proc) fails the process check before anything is deleted.
        for (const check of [strayProcessProblem, scratchProblem]) {
          const problems = await collect([check]);
          if (problems.length) throw poison(problems);
        }

        let outcome: { ok: true; value: T } | { ok: false; error: unknown };
        try {
          const rendering = createWorkspace(scratchRoot).then(render);
          const renderBy = deadline === undefined ? undefined : deadline - killTimeoutMs - TEARDOWN_MARGIN_MS;
          outcome = { ok: true, value: await settleBy(rendering, renderBy) };
        } catch (error) {
          outcome = { ok: false, error };
        }

        const after = await collect([killDescendants, strayProcessProblem, scratchProblem]);
        if (after.length) throw poison(after);
        if (!outcome.ok) throw outcome.error;
        return outcome.value;
      } finally {
        busy = false;
      }
    },
  };
}

/** Live processes other than PID 1, `selfPid` and its ancestors; undefined when `selfPid` is not listed. */
export function strayProcesses(entries: readonly ProcessEntry[], selfPid: number): ProcessEntry[] | undefined {
  const byPid = new Map(entries.map(entry => [entry.pid, entry]));
  if (!byPid.has(selfPid)) return undefined;
  // PID 1 is the sandbox's init, which a render can never leave behind. On Lambda it need not be an
  // ancestor: the runtime's parent can sit outside the sandbox's PID namespace, so its PPID reads 0.
  // A process merely reparented to init (PPID 1) is still stray.
  const allowed = new Set<number>([INIT_PID]);
  for (let entry = byPid.get(selfPid); entry && !allowed.has(entry.pid); entry = byPid.get(entry.ppid)) {
    allowed.add(entry.pid);
  }
  return entries.filter(entry => isLive(entry) && !allowed.has(entry.pid));
}

/** Live processes descended from `rootPid`, found by walking parent PIDs. */
export function liveDescendants(entries: readonly ProcessEntry[], rootPid: number): ProcessEntry[] {
  const children = new Map<number, ProcessEntry[]>();
  for (const entry of entries) {
    const siblings = children.get(entry.ppid);
    if (siblings) siblings.push(entry);
    else children.set(entry.ppid, [entry]);
  }
  const found: ProcessEntry[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    for (const child of children.get(queue.pop() as number) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      queue.push(child.pid);
      if (isLive(child)) found.push(child);
    }
  }
  return found;
}

/**
 * The Linux process table from /proc. Fails rather than skip a process it cannot read, so an
 * unreadable entry can never pass the stray-process check by omission.
 */
export const procfsProcessTable: ProcessTable = {
  async list() {
    const pids = (await readdir('/proc')).filter(name => /^\d+$/.test(name));
    const entries = await Promise.all(pids.map(readProcStat));
    return entries.filter((entry): entry is ProcessEntry => entry !== undefined);
  },
  kill(pid) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone (or not ours to signal); the next listing decides whether that matters.
    }
  },
};

async function readProcStat(pid: string): Promise<ProcessEntry | undefined> {
  let stat: string;
  try {
    stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  } catch (err) {
    // Exited between the directory listing and this read.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ESRCH') {
      return undefined;
    }
    throw err;
  }
  const entry = parseProcStat(stat);
  if (!entry) throw new Error(`unreadable /proc/${pid}/stat`);
  return entry;
}

/** PF_KTHREAD in the `flags` field of /proc/<pid>/stat. */
const PF_KTHREAD = 0x00200000;

/** Parses `pid (comm) state ppid pgrp session tty_nr tpgid flags ...`; comm may hold spaces and parens. */
export function parseProcStat(stat: string): ProcessEntry | undefined {
  const open = stat.indexOf('(');
  const close = stat.lastIndexOf(')');
  if (open < 0 || close < open) return undefined;
  const pid = Number(stat.slice(0, open).trim());
  const [state, ppid, , , , , flags] = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  if (!Number.isInteger(pid) || !state || !Number.isInteger(Number(ppid)) || !Number.isFinite(Number(flags))) {
    return undefined;
  }
  return {
    pid,
    ppid: Number(ppid),
    state,
    name: stat.slice(open + 1, close),
    kernelThread: (Number(flags) & PF_KTHREAD) !== 0,
  };
}

function isLive(entry: ProcessEntry): boolean {
  return !entry.kernelThread && !EXITED_STATES.has(entry.state);
}

async function createWorkspace(scratchRoot: string): Promise<RenderWorkspace> {
  const dir = await mkdtemp(path.join(scratchRoot, WORKSPACE_PREFIX));
  const workspace = { userDataDir: path.join(dir, 'profile'), tmpDir: path.join(dir, 'tmp') };
  await mkdir(workspace.userDataDir, { mode: 0o700 });
  await mkdir(workspace.tmpDir, { mode: 0o700 });
  return workspace;
}

/** Removes every entry under `dir` (never `dir` itself); returns what is still there. */
async function emptyDirectory(dir: string): Promise<string[]> {
  const names = await readdir(dir);
  await Promise.all(
    names.map(name => rm(path.join(dir, name), { recursive: true, force: true }).catch(() => undefined))
  );
  return readdir(dir);
}

/** Runs each check in order; one that throws counts as failed, so a broken check can never pass. */
async function collect(checks: Array<() => Promise<string | undefined>>): Promise<string[]> {
  const problems: string[] = [];
  for (const check of checks) {
    try {
      const problem = await check();
      if (problem) problems.push(problem);
    } catch (err) {
      problems.push(`check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return problems;
}

/** `pid name` pairs for a log line. */
function describe(entries: readonly ProcessEntry[]): string {
  const shown = entries
    .slice(0, 10)
    .map(entry => `${entry.pid} ${plain(entry.name, 16)}`)
    .join(', ');
  return `[${shown}${entries.length > 10 ? `, +${entries.length - 10} more` : ''}]`;
}

/**
 * `pid ppid state name` for every entry, kernel threads and exited processes included. Uncapped:
 * Lambda allows an execution environment 1,024 processes, far below the log event size limit.
 */
function describeTable(entries: readonly ProcessEntry[]): string {
  return `[${entries.map(entry => `${entry.pid} ${entry.ppid} ${plain(entry.state, 1)} ${plain(entry.name, 16)}`).join(', ')}]`;
}

/** Process-controlled text kept short and plain for a one-line log. */
function plain(text: string, maxLength: number): string {
  return text.replace(/[^\w.-]/g, '?').slice(0, maxLength);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Settles as `work` does, or rejects with RenderDeadlineError once `by` (epoch ms) passes first. */
function settleBy<T>(work: Promise<T>, by: number | undefined): Promise<T> {
  if (by === undefined) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new RenderDeadlineError('the render did not finish in the time its invocation had left')),
      Math.max(0, by - Date.now())
    );
  });
  // race() also handles `work` rejecting later, once the teardown has killed its browser.
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

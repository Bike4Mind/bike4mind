import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { SandboxedCommand } from './sandbox';

/** Set on every Windows command; each process it starts inherits it, which is how a stop finds them. */
export const COMMAND_TAG_ENV = 'B4M_DESKTOP_COMMAND_TAG';

const WINDOWS_SIGNAL_TIMEOUT_MS = 15_000;

export interface CommandTree {
  /** The spawned child's pid. On POSIX the child leads its own process group. */
  pid: number;
  child: ChildProcess;
  launch: SandboxedCommand;
}

/**
 * Run under Git Bash with `<signal> <tag>...`. A Windows process has no group to signal, and its
 * Windows parent links break across MSYS fork and exec, so the tree is found by the tag in each
 * MSYS process's environment instead. KILL goes through taskkill /T, so native programs the
 * command started go down with their MSYS parents.
 */
export const WINDOWS_TREE_SCRIPT = `
sig=$1
shift
pids= winpids=
for p in /proc/[0-9]*; do
  hit=
  while IFS= read -r -d '' entry; do
    for tag in "$@"; do [ "$entry" = "${COMMAND_TAG_ENV}=$tag" ] && hit=1; done
    [ -n "$hit" ] && break
  done 2>/dev/null < "$p/environ"
  [ -n "$hit" ] || continue
  pids="$pids \${p#/proc/}"
  IFS= read -r winpid < "$p/winpid" && winpids="$winpids //PID $winpid"
done
if [ "$sig" = KILL ]; then
  [ -z "$winpids" ] || taskkill //F //T $winpids >/dev/null 2>&1
elif [ -n "$pids" ]; then
  kill -s "$sig" $pids 2>/dev/null
fi
exit 0
`;

/** Children this side sent KILL; taskkill ends them with exit code 1, which says nothing of the kill. */
const killed = new WeakSet<ChildProcess>();

function windowsArgs(trees: readonly CommandTree[], signal: NodeJS.Signals): string[] {
  const tags = trees.map(tree => tree.launch.processTag).filter((tag): tag is string => Boolean(tag));
  return ['-c', WINDOWS_TREE_SCRIPT, 'b4m-signal', signal === 'SIGKILL' ? 'KILL' : 'TERM', ...tags];
}

/**
 * The spawned launcher goes by its handle, never by pid: a pid passed to taskkill could belong to
 * another process by the time it runs. The tag sweep covers everything the launcher started.
 */
function killLaunchers(trees: readonly CommandTree[]): void {
  for (const tree of trees) {
    killed.add(tree.child);
    tree.child.kill('SIGKILL');
  }
}

function posixSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone, or the group outlived its leader; nothing left to signal.
  }
}

/** Signal numbers as the MSYS (Cygwin) runtime under Git Bash numbers them, which differ from the host's. */
const MSYS_SIGNALS: Readonly<Record<number, NodeJS.Signals>> = {
  1: 'SIGHUP',
  2: 'SIGINT',
  3: 'SIGQUIT',
  4: 'SIGILL',
  5: 'SIGTRAP',
  6: 'SIGABRT',
  8: 'SIGFPE',
  9: 'SIGKILL',
  10: 'SIGBUS',
  11: 'SIGSEGV',
  12: 'SIGSYS',
  13: 'SIGPIPE',
  14: 'SIGALRM',
  15: 'SIGTERM',
  16: 'SIGURG',
  17: 'SIGSTOP',
  18: 'SIGTSTP',
  19: 'SIGCONT',
  20: 'SIGCHLD',
  21: 'SIGTTIN',
  22: 'SIGTTOU',
  23: 'SIGIO',
  24: 'SIGXCPU',
  25: 'SIGXFSZ',
  26: 'SIGVTALRM',
  27: 'SIGPROF',
  28: 'SIGWINCH',
  30: 'SIGUSR1',
  31: 'SIGUSR2',
};

/**
 * On Windows, reads Git Bash's `signal << 8` exit code back as the signal, and reports SIGKILL for
 * a child this side killed.
 */
export function commandExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  child?: ChildProcess,
  platform: NodeJS.Platform = process.platform
): { code: number | null; signal: NodeJS.Signals | null } {
  if (platform !== 'win32') return { code, signal };
  if (child && killed.has(child)) return { code: null, signal: 'SIGKILL' };
  if (code === null || code < 256 || code % 256 !== 0) return { code, signal };
  const name = MSYS_SIGNALS[code / 256];
  return name ? { code: null, signal: name } : { code, signal };
}

/** Signal a command and everything it started. Returns at once; on Windows the work finishes in the background. */
export function signalCommandTree(tree: CommandTree, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32') {
    posixSignal(tree.pid, signal);
    return;
  }
  const sweep = spawn(tree.launch.executable, windowsArgs([tree], signal), {
    stdio: 'ignore',
    windowsHide: true,
    timeout: WINDOWS_SIGNAL_TIMEOUT_MS,
  });
  sweep.on('error', () => undefined);
  if (signal === 'SIGKILL') killLaunchers([tree]);
}

/** For handlers that cannot await. On Windows this blocks for one Git Bash run, however many trees. */
export function signalCommandTreesSync(trees: readonly CommandTree[], signal: NodeJS.Signals): void {
  if (process.platform !== 'win32') {
    for (const tree of trees) posixSignal(tree.pid, signal);
    return;
  }
  const first = trees[0];
  if (!first) return;
  spawnSync(first.launch.executable, windowsArgs(trees, signal), {
    stdio: 'ignore',
    windowsHide: true,
    timeout: WINDOWS_SIGNAL_TIMEOUT_MS,
  });
  if (signal === 'SIGKILL') killLaunchers(trees);
}

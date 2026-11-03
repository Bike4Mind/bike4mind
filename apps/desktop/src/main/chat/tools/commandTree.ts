import { spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:os';
import type { SandboxedCommand } from './sandbox';

/** Set on every Windows command; each process it starts inherits it, which is how a stop finds them. */
export const COMMAND_TAG_ENV = 'B4M_DESKTOP_COMMAND_TAG';

const WINDOWS_SIGNAL_TIMEOUT_MS = 15_000;

export interface CommandTree {
  /** The spawned child's pid. On POSIX the child leads its own process group. */
  pid: number;
  launch: SandboxedCommand;
}

/**
 * Run under Git Bash with `<signal> "<child pid>..." <tag>...`. A Windows process has no group to
 * signal, and its Windows parent links break across MSYS fork and exec, so the tree is found by
 * the tag in each MSYS process's environment instead. KILL goes through taskkill /T, so native
 * programs the command started go down with their MSYS parents.
 */
export const WINDOWS_TREE_SCRIPT = `
sig=$1 children=$2
shift 2
pids= winpids=
for winpid in $children; do winpids="$winpids //PID $winpid"; done
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
  taskkill //F //T $winpids >/dev/null 2>&1
elif [ -n "$pids" ]; then
  kill -s "$sig" $pids 2>/dev/null
fi
exit 0
`;

function windowsSignal(signal: NodeJS.Signals): 'KILL' | 'TERM' {
  return signal === 'SIGKILL' ? 'KILL' : 'TERM';
}

function windowsArgs(trees: readonly CommandTree[], signal: NodeJS.Signals): string[] {
  const tags = trees.map(tree => tree.launch.processTag).filter((tag): tag is string => Boolean(tag));
  const children = trees.map(tree => tree.pid).join(' ');
  return ['-c', WINDOWS_TREE_SCRIPT, 'b4m-signal', windowsSignal(signal), children, ...tags];
}

function posixSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone, or the group outlived its leader; nothing left to signal.
  }
}

/** Git Bash ends a signalled command with exit code `signal << 8`; read that back as the signal. */
export function commandExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  platform: NodeJS.Platform = process.platform
): { code: number | null; signal: NodeJS.Signals | null } {
  if (platform !== 'win32' || code === null || code < 256 || code % 256 !== 0) return { code, signal };
  const number = code / 256;
  const name = (Object.keys(constants.signals) as NodeJS.Signals[]).find(key => constants.signals[key] === number);
  return name ? { code: null, signal: name } : { code, signal };
}

/** Signal a command and everything it started. Returns at once; on Windows the work finishes in the background. */
export function signalCommandTree(tree: CommandTree, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32') {
    posixSignal(tree.pid, signal);
    return;
  }
  const child = spawn(tree.launch.executable, windowsArgs([tree], signal), {
    stdio: 'ignore',
    windowsHide: true,
    timeout: WINDOWS_SIGNAL_TIMEOUT_MS,
  });
  child.on('error', () => undefined);
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
}

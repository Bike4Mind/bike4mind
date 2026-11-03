import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { system32 } from './gitBash';
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
 * `<taskkill.exe|''> <signal> <tag>...`: finds the command's processes by the tag in their environment,
 * and given taskkill force-ends each with its native descendants (an MSYS signal ends an exec'd program alone).
 */
export const WINDOWS_TREE_SCRIPT = `
taskkill=$1 sig=$2
shift 2
for p in /proc/[0-9]*; do
  hit=
  while IFS= read -r -d '' entry; do
    for tag in "$@"; do [ "$entry" = "${COMMAND_TAG_ENV}=$tag" ] && hit=1; done
    [ -n "$hit" ] && break
  done 2>/dev/null < "$p/environ"
  [ -n "$hit" ] || continue
  if [ -n "$taskkill" ]; then
    IFS= read -r winpid 2>/dev/null < "$p/winpid" && "$taskkill" //F //T //PID "$winpid" >/dev/null 2>&1
  else
    kill -s "$sig" "\${p#/proc/}" 2>/dev/null
  fi
done
exit 0
`;

interface Invocation {
  file: string;
  args: string[];
}

function tagsOf(trees: readonly CommandTree[]): string[] {
  return trees.map(tree => tree.launch.processTag).filter((tag): tag is string => Boolean(tag));
}

/**
 * What to run to signal `trees` on Windows: one forced Git Bash sweep, plus one per WSL distro,
 * where Linux processes take the signal as sent.
 */
export function windowsSignalCommands(trees: readonly CommandTree[], signal: NodeJS.Signals): Invocation[] {
  const name = signal === 'SIGKILL' ? 'KILL' : 'TERM';
  const native = trees.filter(tree => !tree.launch.wslDistro);
  const commands: Invocation[] = [];
  const first = native[0];
  if (first) {
    commands.push({
      file: first.launch.executable,
      args: ['-c', WINDOWS_TREE_SCRIPT, 'b4m-signal', system32('taskkill.exe'), 'KILL', ...tagsOf(native)],
    });
  }
  const distros = new Set(trees.map(tree => tree.launch.wslDistro).filter((distro): distro is string => !!distro));
  for (const distro of distros) {
    const inDistro = trees.filter(tree => tree.launch.wslDistro === distro);
    commands.push({
      file: 'wsl.exe',
      args: ['-d', distro, '--exec', 'bash', '-c', WINDOWS_TREE_SCRIPT, 'b4m-signal', '', name, ...tagsOf(inDistro)],
    });
  }
  return commands;
}

/** Children this side stopped; taskkill ends them with exit code 1, which says nothing of the kill. */
const killed = new WeakSet<ChildProcess>();

/** Git Bash launchers go on every stop, which is always forced there; wsl.exe goes on KILL. */
function launchersToEnd(trees: readonly CommandTree[], signal: NodeJS.Signals): CommandTree[] {
  return trees.filter(tree => !tree.launch.wslDistro || signal === 'SIGKILL');
}

/**
 * The spawned launcher (Git Bash's or wsl.exe) goes by its handle, never by pid: a pid passed to
 * taskkill could belong to another process by the time it runs. The tag sweep covers the rest.
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
 * On Windows, reads Git Bash's `signal << 8` exit code (0x80 set for a core dump) back as the
 * signal, and reports SIGKILL for a child this side stopped.
 */
export function commandExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  child?: ChildProcess,
  platform: NodeJS.Platform = process.platform
): { code: number | null; signal: NodeJS.Signals | null } {
  if (platform !== 'win32') return { code, signal };
  if (child && killed.has(child)) return { code: null, signal: 'SIGKILL' };
  if (code === null || code < 0x100 || code >= 0x10000 || (code & 0xff) !== 0) return { code, signal };
  const name = MSYS_SIGNALS[(code >> 8) & 0x7f];
  return name ? { code: null, signal: name } : { code, signal };
}

/**
 * Signal a command and everything it started. Returns at once; on Windows the work finishes in the
 * background, and every stop is forced. The launcher goes once the sweep is done, so the tree is intact for it.
 */
export function signalCommandTree(tree: CommandTree, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32') {
    posixSignal(tree.pid, signal);
    return;
  }
  const launchers = launchersToEnd([tree], signal);
  for (const launcher of launchers) killed.add(launcher.child);
  for (const command of windowsSignalCommands([tree], signal)) {
    const sweep = spawn(command.file, command.args, {
      stdio: 'ignore',
      windowsHide: true,
      timeout: WINDOWS_SIGNAL_TIMEOUT_MS,
    });
    sweep.on('error', () => killLaunchers(launchers));
    sweep.on('exit', () => killLaunchers(launchers));
  }
}

/** For handlers that cannot await. On Windows this blocks for one sweep per shell, however many trees. */
export function signalCommandTreesSync(trees: readonly CommandTree[], signal: NodeJS.Signals): void {
  if (process.platform !== 'win32') {
    for (const tree of trees) posixSignal(tree.pid, signal);
    return;
  }
  for (const command of windowsSignalCommands(trees, signal)) {
    spawnSync(command.file, command.args, {
      stdio: 'ignore',
      windowsHide: true,
      timeout: WINDOWS_SIGNAL_TIMEOUT_MS,
    });
  }
  killLaunchers(launchersToEnd(trees, signal));
}

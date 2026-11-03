import { spawn, type ChildProcess } from 'node:child_process';
import { system32 } from '../chat/tools/gitBash';

/** A folder inside a WSL distro, reached from Windows over `\\wsl.localhost\<distro>\...` or `\\wsl$\<distro>\...`. */
export interface WslLocation {
  /** The share name as written, so paths mapped back match the ones the user picked. */
  host: 'wsl.localhost' | 'wsl$';
  distro: string;
  /** Absolute, with forward slashes. */
  linuxPath: string;
}

/** Carries the distro user's PATH into a `wslCommand`; see `wslCommandEnv`. */
const LINUX_PATH_ENV = 'B4M_DESKTOP_LINUX_PATH';

const WSL_UNC = /^(?:[\\/]{2}[?.][\\/]UNC[\\/]|[\\/]{2})(wsl\.localhost|wsl\$)[\\/]+([^\\/]+)(?:[\\/]+(.*))?$/i;

/** Also reads the `\\?\UNC\...` and `\\.\UNC\...` spellings of the share. */
export function parseWslPath(path: string): WslLocation | null {
  const match = WSL_UNC.exec(path);
  if (!match) return null;
  const segments = (match[3] ?? '').split(/[\\/]+/).filter(Boolean);
  return {
    host: (match[1] as string).toLowerCase() === 'wsl$' ? 'wsl$' : 'wsl.localhost',
    distro: match[2] as string,
    linuxPath: `/${segments.join('/')}`,
  };
}

/** The WSL location of `directory`, or null for an ordinary folder or a host that is not Windows. */
export function wslLocation(directory: string, platform: NodeJS.Platform = process.platform): WslLocation | null {
  return platform === 'win32' ? parseWslPath(directory) : null;
}

export function wslUncPath(location: Pick<WslLocation, 'host' | 'distro'>, linuxPath: string): string {
  const rest = linuxPath.split('/').filter(Boolean).join('\\');
  return `\\\\${location.host}\\${location.distro}\\${rest}`;
}

/** A path a Linux program printed, as Windows reaches it; anything not absolute is returned as is. */
export function toWindowsPath(location: Pick<WslLocation, 'host' | 'distro'>, path: string): string {
  return path.startsWith('/') ? wslUncPath(location, path) : path;
}

/** A Windows path to a folder in the same distro, as a Linux program there must be given it. */
export function toLinuxArgument(location: WslLocation, argument: string): string {
  const named = parseWslPath(argument);
  return named && named.distro.toLowerCase() === location.distro.toLowerCase() ? named.linuxPath : argument;
}

/** wsl.exe writes its own messages as UTF-16 unless told otherwise. Set on every wsl.exe spawn. */
export function wslSpawnEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, WSL_UTF8: '1' };
}

/**
 * `wsl.exe --cd` falls back to the home folder when the folder is missing, and plain `wsl.exe --`
 * re-parses its arguments through the login shell. `--exec` with this script does neither.
 */
const ENTER_FOLDER = `cd -- "$1" || exit 125; shift; [ -z "$${LINUX_PATH_ENV}" ] || export PATH="$${LINUX_PATH_ENV}"; exec "$@"`;

/** `file args...` run by the distro's own toolchain in `location`. Arguments reach Linux as given. */
export function wslCommand(
  location: WslLocation,
  file: string,
  args: readonly string[]
): { file: string; args: string[] } {
  return {
    file: system32('wsl.exe'),
    args: [
      '-d',
      location.distro,
      '--exec',
      '/bin/sh',
      '-c',
      ENTER_FOLDER,
      'b4m-wsl',
      location.linuxPath,
      file,
      ...args,
    ],
  };
}

export interface WslUserEnvironment {
  path: string;
  /** The distro user's home, as a Linux path. */
  home: string;
}

const USER_ENV_TIMEOUT_MS = 20_000;
/** A failed probe is asked again after this long, so a distro that was starting up is not given up on. */
const USER_ENV_RETRY_MS = 30_000;
/** A probe that timed out is likely held by a startup file, so it is asked again only after this long. */
const USER_ENV_TIMEOUT_RETRY_MS = 10 * 60_000;
/** How long a caller waits on a probe another caller started before going on without it. */
const USER_ENV_JOIN_MS = 2_000;
const MARKER = '__B4M_ENV__';

/**
 * Asks the user's login shell from the passwd entry, as a terminal in the distro would start it.
 * The printf is quoted to work in sh, bash, zsh and fish alike.
 */
export const USER_ENV_SCRIPT = `shell=$(getent passwd "$(id -un)" | cut -d: -f7); [ -x "$shell" ] || shell=/bin/sh; exec "$shell" -ilc "$1"`;
export const USER_ENV_PRINT = `printf '%s' '${MARKER}' "$PATH" '${MARKER}' "$HOME" '${MARKER}'`;

/** What `USER_ENV_PRINT` wrote, past whatever the shell's startup files printed around it. */
export function parseUserEnvironment(stdout: string): WslUserEnvironment | null {
  const [, path, home] = stdout.split(MARKER);
  return path && home?.startsWith('/') ? { path, home } : null;
}

export interface UserEnvironmentProbe {
  found: WslUserEnvironment | null;
  timedOut: boolean;
}

function probeUserEnvironment(distro: string): Promise<UserEnvironmentProbe> {
  return new Promise(resolve => {
    // stdin is closed so a startup file that reads it gets end of input instead of waiting.
    const child = spawn(
      system32('wsl.exe'),
      ['-d', distro, '--exec', '/bin/sh', '-c', USER_ENV_SCRIPT, 'b4m-env', USER_ENV_PRINT],
      {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        env: wslSpawnEnv(),
      }
    );
    let stdout = '';
    let timedOut = false;
    let settled = false;
    const finish = (found: WslUserEnvironment | null) => {
      if (settled) return;
      settled = true;
      resolve({ found, timedOut });
    };
    // Also ends a wsl.exe that answered but is still held open by something a startup file left running.
    const timer = setTimeout(() => {
      timedOut = !settled;
      child.kill('SIGKILL');
    }, USER_ENV_TIMEOUT_MS);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      // The answer is whole at the third marker, whenever and however the shell exits after it.
      if (stdout.split(MARKER).length > 3) finish(parseUserEnvironment(stdout));
    });
    const ended = () => {
      clearTimeout(timer);
      finish(null);
    };
    child.on('error', ended);
    child.on('close', ended);
  });
}

interface UserEnvironmentEntry {
  found: Promise<WslUserEnvironment | null>;
  settled: boolean;
  /** When the probe may be run again; Infinity once it succeeded, or while it runs. */
  retryAt: number;
}

const userEnvironments = new Map<string, UserEnvironmentEntry>();

function within<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
    void promise.then(value => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

/**
 * The PATH and home the user's login shell in the distro has, where nvm and similar put node and
 * pnpm; `--exec` alone starts with the bare system PATH. Null when the shell cannot be asked, and
 * for a caller that joins a probe still running after `USER_ENV_JOIN_MS`.
 */
export function wslUserEnvironment(
  distro: string,
  now: () => number = Date.now,
  probe: (distro: string) => Promise<UserEnvironmentProbe> = probeUserEnvironment
): Promise<WslUserEnvironment | null> {
  const cached = userEnvironments.get(distro);
  if (cached && now() < cached.retryAt) return cached.settled ? cached.found : within(cached.found, USER_ENV_JOIN_MS);
  const entry: UserEnvironmentEntry = { found: Promise.resolve(null), settled: false, retryAt: Infinity };
  entry.found = probe(distro).then(({ found, timedOut }) => {
    entry.settled = true;
    if (!found) entry.retryAt = now() + (timedOut ? USER_ENV_TIMEOUT_RETRY_MS : USER_ENV_RETRY_MS);
    return found;
  });
  userEnvironments.set(distro, entry);
  return entry.found;
}

/** A WSLENV entry with the `w` flag only crosses from Linux back to Windows. */
const crossesIntoLinux = (entry: string): boolean => !(entry.split('/')[1] ?? '').includes('w');

/** The names of the Windows variables wsl.exe passes into Linux, as WSLENV in `env` lists them. */
export function wslEnvNames(env: NodeJS.ProcessEnv): string[] {
  return (env.WSLENV ?? '')
    .split(':')
    .filter(entry => entry && crossesIntoLinux(entry))
    .map(entry => entry.split('/')[0] as string);
}

/** Adds names to WSLENV so they cross into Linux, dropping a `w` flag that would keep a listed one out. */
export function withWslEnv(env: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv {
  const needed = new Set(names);
  const listed = (env.WSLENV ?? '').split(':').filter(Boolean);
  const kept = listed.map(entry => {
    const [name = '', flags = ''] = entry.split('/');
    if (!needed.has(name) || crossesIntoLinux(entry)) return entry;
    const rest = flags.replaceAll('w', '');
    return rest ? `${name}/${rest}` : name;
  });
  const known = new Set(listed.map(entry => entry.split('/')[0]));
  return { ...env, WSLENV: [...kept, ...[...needed].filter(name => !known.has(name))].join(':') };
}

/**
 * The env for a `wslCommand`. Only WSLENV names cross into Linux, so the Windows PATH stays
 * behind and the distro user's PATH goes in its place; `names` are passed through as well.
 */
export async function wslCommandEnv(
  env: NodeJS.ProcessEnv,
  distro: string,
  names: readonly string[] = []
): Promise<NodeJS.ProcessEnv> {
  const user = await wslUserEnvironment(distro);
  if (!user) return wslSpawnEnv(withWslEnv(env, names));
  return wslSpawnEnv(withWslEnv({ ...env, [LINUX_PATH_ENV]: user.path }, [...names, LINUX_PATH_ENV]));
}

const REALPATH_TIMEOUT_MS = 5_000;
/** The first lookup of a session can include starting the distro. */
const REALPATH_START_TIMEOUT_MS = 30_000;
const REALPATH_IDLE_MS = 10_000;

/**
 * Answers each NUL-terminated path with its physical form, NUL-terminated, or an empty answer when
 * it has none. No command substitution, which would strip a trailing newline from the answer.
 */
export const REALPATH_SCRIPT = `while IFS= read -r -d '' p; do realpath -zm -- "$p" 2>/dev/null || printf '\\0'; done`;

interface RealpathSession {
  child: ChildProcess;
  /** Each gets the answer, null for none, or undefined when the session ended first. */
  pending: ((path: string | null | undefined) => void)[];
  buffered: string;
  answered: boolean;
  idle?: NodeJS.Timeout;
}

const realpathSessions = new Map<string, RealpathSession>();

function endSession(distro: string, session: RealpathSession): void {
  if (realpathSessions.get(distro) === session) realpathSessions.delete(distro);
  if (session.idle) clearTimeout(session.idle);
  for (const answer of session.pending.splice(0)) answer(undefined);
  session.child.kill('SIGKILL');
}

function realpathSession(distro: string): RealpathSession {
  const open = realpathSessions.get(distro);
  if (open) return open;
  const child = spawn(system32('wsl.exe'), ['-d', distro, '--exec', 'bash', '-c', REALPATH_SCRIPT], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
    env: wslSpawnEnv(),
  });
  const session: RealpathSession = { child, pending: [], buffered: '', answered: false };
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    session.buffered += chunk;
    let end = session.buffered.indexOf('\0');
    while (end !== -1) {
      const answer = session.buffered.slice(0, end);
      session.buffered = session.buffered.slice(end + 1);
      session.answered = true;
      session.pending.shift()?.(answer.startsWith('/') ? answer : null);
      end = session.buffered.indexOf('\0');
    }
  });
  child.on('error', () => endSession(distro, session));
  child.on('exit', () => endSession(distro, session));
  child.stdin?.on('error', () => endSession(distro, session));
  child.unref();
  realpathSessions.set(distro, session);
  return session;
}

/**
 * Where `linuxPath` lands inside `distro` with every symlink followed, as a Linux path; null when
 * it cannot be resolved. Windows cannot follow a Linux symlink over the share, so the distro is
 * asked. One wsl.exe per distro answers every lookup until it has been idle for a while; a lookup
 * cut short by the session ending is asked once more of a new one.
 */
export async function wslRealpath(distro: string, linuxPath: string): Promise<string | null> {
  if (linuxPath.includes('\0')) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = await askSession(distro, linuxPath);
    if (answer !== undefined) return answer;
  }
  return null;
}

function askSession(distro: string, linuxPath: string): Promise<string | null | undefined> {
  const session = realpathSession(distro);
  if (session.idle) clearTimeout(session.idle);
  return new Promise(resolve => {
    const timeout = session.answered ? REALPATH_TIMEOUT_MS : REALPATH_START_TIMEOUT_MS;
    const timer = setTimeout(() => endSession(distro, session), timeout);
    session.pending.push(path => {
      clearTimeout(timer);
      resolve(path);
      if (session.pending.length === 0 && realpathSessions.get(distro) === session) {
        session.idle = setTimeout(() => endSession(distro, session), REALPATH_IDLE_MS);
        session.idle.unref?.();
      }
    });
    session.child.stdin?.write(`${linuxPath}\0`);
  });
}

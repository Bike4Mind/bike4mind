import { execFile } from 'node:child_process';
import { access, constants, stat } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { delimiter, join, posix, win32 } from 'node:path';

/** Generous on purpose: a login shell loading nix-darwin, direnv and plugins takes seconds, more on a cold launch. */
const SHELL_PATH_TIMEOUT_MS = 20_000;
const PATH_MARKER = '__B4M_PATH__';
const ENV_MARKER = '__B4M_ENV__';
/** Room for a large environment (Node's default is 1 MiB); a probe that overflows it falls back like one that fails. */
const SHELL_ENV_MAX_BUFFER = 4 * 1024 * 1024;
/**
 * PATH is printed on its own, not read from the `env -0` listing, so it survives an `env` without `-0`
 * (macOS before 12.3); such a probe loses only the extra variables. Constant text: nothing user-controlled.
 */
const PROBE_COMMAND = [
  `printf '%s' "${PATH_MARKER}\${PATH}${PATH_MARKER}"`,
  `printf '%s' '${ENV_MARKER}'`,
  '/usr/bin/env -0',
  `printf '%s' '${ENV_MARKER}'`,
].join('; ');

/**
 * Where Homebrew and Nix put binaries. A Finder launch gets /usr/bin:/bin:/usr/sbin:/sbin, which has
 * neither node, gh nor a package manager; these keep them reachable when the shell probe fails.
 */
function commonBinDirs(): string[] {
  const user = process.env.USER || userInfo().username;
  return [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    join(homedir(), '.nix-profile', 'bin'),
    `/etc/profiles/per-user/${user}/bin`,
    '/run/current-system/sw/bin',
    '/nix/var/nix/profiles/default/bin',
  ];
}

/**
 * Variables that describe the probe's own shell session rather than the user's setup, and exported bash
 * functions, which bash would import into every command.
 */
const SESSION_VARIABLES = new Set(['PATH', 'PWD', 'OLDPWD', 'SHLVL', '_', 'TERM', 'COLUMNS', 'LINES']);
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isUserVariable(name: string): boolean {
  return VARIABLE_NAME.test(name) && !SESSION_VARIABLES.has(name);
}

/** The NUL-separated `env -0` listing between the two markers in `stdout`, or null when there is none. */
export function parseShellEnvironment(stdout: string): Map<string, string> | null {
  const start = stdout.indexOf(ENV_MARKER);
  const end = stdout.lastIndexOf(ENV_MARKER);
  if (start < 0 || end <= start) return null;
  const listing = stdout.slice(start + ENV_MARKER.length, end);
  const variables = new Map<string, string>();
  for (const entry of listing.split('\0')) {
    const equals = entry.indexOf('=');
    if (equals > 0) variables.set(entry.slice(0, equals), entry.slice(equals + 1));
  }
  return variables.size > 0 ? variables : null;
}

type LoginShell = { path: string; variables: Readonly<Record<string, string>> };

/**
 * Asks the user's login shell once for its PATH and environment (PROBE_COMMAND). A shell that fails,
 * hangs past the timeout or overflows the buffer leaves only the fallback PATH and no extra variables.
 */
function probeLoginShell(): Promise<LoginShell> {
  cachedShell ??= new Promise<LoginShell>(resolve => {
    const fallback = [...(process.env.PATH ?? '').split(delimiter), ...commonBinDirs()]
      .filter(Boolean)
      .filter((entry, index, all) => all.indexOf(entry) === index)
      .join(delimiter);
    execFile(
      process.env.SHELL || '/bin/zsh',
      ['-ilc', PROBE_COMMAND],
      // SIGKILL: an interactive (-i) zsh/bash ignores the default SIGTERM, so the timeout would not cut it short.
      {
        timeout: SHELL_PATH_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: SHELL_ENV_MAX_BUFFER,
        env: { ...process.env, TERM: 'dumb' },
      },
      (error, stdout) => {
        const shellPath = error ? undefined : new RegExp(`${PATH_MARKER}(.*?)${PATH_MARKER}`).exec(stdout)?.[1];
        const found = error ? null : parseShellEnvironment(stdout);
        if (error || !found) {
          // Code and signal only: the message carries the shell's stderr, which rc files may fill with anything.
          const reason = error ? `code ${String(error.code)}, signal ${String(error.signal)}` : 'no listing';
          console.warn(`[userPath] login shell probe gave no environment (${reason})`);
        }
        const variables = Object.fromEntries([...(found ?? [])].filter(([name]) => isUserVariable(name)));
        resolve({ path: shellPath ? `${shellPath}${delimiter}${fallback}` : fallback, variables });
      }
    );
  });
  return cachedShell;
}
let cachedShell: Promise<LoginShell> | undefined;

/**
 * The PATH a terminal would have. Electron launched from Finder inherits a minimal one, so a
 * bare `pnpm` would not resolve. Asked of the user's own login shell once: it is the only place
 * version-manager shims (nvm, fnm, volta) are put on PATH. The result, fallback included, is cached
 * for the app's lifetime, so main/index.ts starts it at launch.
 */
export async function resolveUserPath(): Promise<string> {
  // A Windows app gets the user's PATH from the registry however it is launched.
  if (process.platform === 'win32') return process.env.PATH ?? '';
  return (await probeLoginShell()).path;
}

/**
 * The variables the user's login shell exports (`~/.zshenv`, `~/.zprofile`, ...) other than PATH, which
 * a Finder launch never sees. Empty on Windows and when the probe fails. Same cached probe as resolveUserPath.
 */
export async function resolveLoginShellVariables(): Promise<Readonly<Record<string, string>>> {
  if (process.platform === 'win32') return {};
  return (await probeLoginShell()).variables;
}

async function isExecutableFile(file: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false;
    if (platform !== 'win32') await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** A drive or UNC prefix; `\dir` alone follows the current drive, so it is not rooted. */
export const WINDOWS_ROOTED = /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/])/i;

/**
 * The absolute path of `name` in the first absolute PATH directory that has it, `<name>.exe` on
 * Windows. Relative entries are skipped, so nothing resolves from the working directory.
 */
export async function findOnPath(
  name: string,
  path: string,
  platform: NodeJS.Platform = process.platform,
  isExecutable: (file: string) => Promise<boolean> = file => isExecutableFile(file, platform)
): Promise<string | null> {
  const windows = platform === 'win32';
  const file = windows ? `${name}.exe` : name;
  for (const entry of path.split(windows ? ';' : ':')) {
    const directory = entry.trim().replace(/^"(.*)"$/, '$1');
    if (windows ? !WINDOWS_ROOTED.test(directory) : !posix.isAbsolute(directory)) continue;
    const candidate = (windows ? win32 : posix).join(directory, file);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

const found = new Map<string, string>();

/**
 * The file to spawn for the program `name`: on Windows its absolute path from `path` (see
 * `findOnPath`), kept while it still exists, or null when there is none; elsewhere `name` itself.
 */
export async function hostProgram(
  name: string,
  path: string = process.env.PATH ?? '',
  platform: NodeJS.Platform = process.platform,
  isExecutable: (file: string) => Promise<boolean> = file => isExecutableFile(file, platform)
): Promise<string | null> {
  if (platform !== 'win32') return name;
  const key = `${name}\0${path}`;
  const kept = found.get(key);
  if (kept && (await isExecutable(kept))) return kept;
  const program = await findOnPath(name, path, platform, isExecutable);
  if (program) found.set(key, program);
  else found.delete(key);
  return program;
}

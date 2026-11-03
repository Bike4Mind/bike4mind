import { execFile } from 'node:child_process';

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

const WSL_UNC = /^[\\/]{2}(wsl\.localhost|wsl\$)[\\/]+([^\\/]+)(?:[\\/]+(.*))?$/i;

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
export function toWindowsPath(location: WslLocation, path: string): string {
  return path.startsWith('/') ? wslUncPath(location, path) : path;
}

/** An argument naming a folder in the same distro, as the Linux program must see it. */
export function toLinuxArgument(location: WslLocation, argument: string): string {
  const named = parseWslPath(argument);
  return named && named.distro.toLowerCase() === location.distro.toLowerCase() ? named.linuxPath : argument;
}

/**
 * `wsl.exe --cd` falls back to the home folder when the folder is missing, and plain `wsl.exe --`
 * re-parses its arguments through the login shell. `--exec` with this script does neither.
 */
const ENTER_FOLDER = `cd -- "$1" || exit 125; shift; [ -z "$${LINUX_PATH_ENV}" ] || export PATH="$${LINUX_PATH_ENV}"; exec "$@"`;

/** `file args...` run by the distro's own toolchain in `location`. Folder arguments are mapped to Linux paths. */
export function wslCommand(
  location: WslLocation,
  file: string,
  args: readonly string[]
): { file: string; args: string[] } {
  return {
    file: 'wsl.exe',
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
      ...args.map(argument => toLinuxArgument(location, argument)),
    ],
  };
}

const USER_PATH_TIMEOUT_MS = 20_000;
const PATH_MARKER = '__B4M_PATH__';
const userPaths = new Map<string, Promise<string | null>>();

/**
 * The PATH an interactive shell in the distro has, where nvm and similar put node and pnpm;
 * `--exec` alone starts with the bare system PATH. Null when the shell cannot be asked.
 */
export function wslUserPath(distro: string): Promise<string | null> {
  let found = userPaths.get(distro);
  if (!found) {
    found = new Promise(resolve => {
      execFile(
        'wsl.exe',
        ['-d', distro, '--exec', 'bash', '-ilc', `printf '%s' "${PATH_MARKER}\${PATH}${PATH_MARKER}"`],
        { timeout: USER_PATH_TIMEOUT_MS, killSignal: 'SIGKILL', windowsHide: true },
        (error, stdout) => {
          resolve(error ? null : (new RegExp(`${PATH_MARKER}(.*)${PATH_MARKER}`).exec(stdout)?.[1] ?? null));
        }
      );
    });
    userPaths.set(distro, found);
  }
  return found;
}

/** Adds names to WSLENV, the list of Windows variables wsl.exe passes into Linux. */
export function withWslEnv(env: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv {
  const listed = (env.WSLENV ?? '').split(':').filter(Boolean);
  const known = new Set(listed.map(entry => entry.split('/')[0]));
  return { ...env, WSLENV: [...listed, ...names.filter(name => !known.has(name))].join(':') };
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
  const path = await wslUserPath(distro);
  if (!path) return withWslEnv(env, names);
  return withWslEnv({ ...env, [LINUX_PATH_ENV]: path }, [...names, LINUX_PATH_ENV]);
}

import { execFile } from 'node:child_process';
import { access, constants, stat } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { delimiter, join, posix, win32 } from 'node:path';

/** Generous on purpose: a login shell loading nix-darwin, direnv and plugins takes seconds, more on a cold launch. */
const SHELL_PATH_TIMEOUT_MS = 20_000;
const PATH_MARKER = '__B4M_PATH__';

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
 * The PATH a terminal would have. Electron launched from Finder inherits a minimal one, so a
 * bare `pnpm` would not resolve. Asked of the user's own login shell once: it is the only place
 * version-manager shims (nvm, fnm, volta) are put on PATH. The result, fallback included, is cached
 * for the app's lifetime, so main/index.ts starts it at launch.
 */
export function resolveUserPath(): Promise<string> {
  // A Windows app gets the user's PATH from the registry however it is launched.
  if (process.platform === 'win32') return Promise.resolve(process.env.PATH ?? '');
  cachedPath ??= new Promise<string>(resolve => {
    const fallback = [...(process.env.PATH ?? '').split(delimiter), ...commonBinDirs()]
      .filter(Boolean)
      .filter((entry, index, all) => all.indexOf(entry) === index)
      .join(delimiter);
    execFile(
      process.env.SHELL || '/bin/zsh',
      ['-ilc', `printf '%s' "${PATH_MARKER}\${PATH}${PATH_MARKER}"`],
      // SIGKILL: an interactive (-i) zsh/bash ignores the default SIGTERM, so the timeout would not cut it short.
      { timeout: SHELL_PATH_TIMEOUT_MS, killSignal: 'SIGKILL', env: { ...process.env, TERM: 'dumb' } },
      (error, stdout) => {
        const found = error ? undefined : new RegExp(`${PATH_MARKER}(.*)${PATH_MARKER}`).exec(stdout)?.[1];
        resolve(found ? `${found}${delimiter}${fallback}` : fallback);
      }
    );
  });
  return cachedPath;
}
let cachedPath: Promise<string> | undefined;

async function isExecutableFile(file: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false;
    if (platform !== 'win32') await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

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
  const paths = platform === 'win32' ? win32 : posix;
  const file = platform === 'win32' ? `${name}.exe` : name;
  for (const entry of path.split(platform === 'win32' ? ';' : ':')) {
    const directory = entry.trim().replace(/^"(.*)"$/, '$1');
    if (!paths.isAbsolute(directory)) continue;
    const candidate = paths.join(directory, file);
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

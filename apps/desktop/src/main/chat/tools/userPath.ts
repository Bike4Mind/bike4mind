import { execFile } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { delimiter, join } from 'node:path';

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

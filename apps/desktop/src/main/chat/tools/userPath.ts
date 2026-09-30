import { execFile } from 'node:child_process';
import { delimiter } from 'node:path';

const SHELL_PATH_TIMEOUT_MS = 5_000;
const PATH_MARKER = '__B4M_PATH__';
/** A Finder launch gets /usr/bin:/bin:/usr/sbin:/sbin, which has neither node nor a package manager. */
const COMMON_BIN_DIRS = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin'];

/**
 * The PATH a terminal would have. Electron launched from Finder inherits a minimal one, so a
 * bare `pnpm` would not resolve. Asked of the user's own login shell once, and cached: it is the
 * only place version-manager shims (nvm, fnm, volta) are put on PATH.
 */
export function resolveUserPath(): Promise<string> {
  cachedPath ??= new Promise<string>(resolve => {
    const fallback = [...(process.env.PATH ?? '').split(delimiter), ...COMMON_BIN_DIRS]
      .filter(Boolean)
      .filter((entry, index, all) => all.indexOf(entry) === index)
      .join(delimiter);
    execFile(
      process.env.SHELL || '/bin/zsh',
      ['-ilc', `printf '%s' "${PATH_MARKER}$PATH${PATH_MARKER}"`],
      { timeout: SHELL_PATH_TIMEOUT_MS, env: { ...process.env, TERM: 'dumb' } },
      (error, stdout) => {
        const found = error ? undefined : new RegExp(`${PATH_MARKER}(.*)${PATH_MARKER}`).exec(stdout)?.[1];
        resolve(found ? `${found}${delimiter}${fallback}` : fallback);
      }
    );
  });
  return cachedPath;
}
let cachedPath: Promise<string> | undefined;

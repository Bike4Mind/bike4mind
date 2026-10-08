import { execFile } from 'node:child_process';
import { resolveUserPath } from '../chat/tools/userPath';

/** A read is one GraphQL round trip; anything slower than this is a hung process, not a slow API. */
const GH_TIMEOUT_MS = 30_000;
const GH_MAX_BUFFER = 8 * 1024 * 1024;

export type GhFailureKind = 'missing' | 'unauthenticated' | 'rate-limited' | 'not-found' | 'failed';

export class GhError extends Error {
  constructor(
    readonly kind: GhFailureKind,
    message: string,
    /** What gh printed anyway. A GraphQL query with some failing parts exits 1 but still prints the rest. */
    readonly stdout?: string
  ) {
    super(message);
    this.name = 'GhError';
  }
}

/** Runs `gh` with arguments and returns stdout. The seam tests replace. */
export type GhRunner = (args: readonly string[], options?: { cwd?: string }) => Promise<string>;

/**
 * Sort a failed `gh` run into what the bar should say about it.
 *
 * Read off gh's own stderr, which is the only place it says why: the exit code is 1 for nearly
 * everything. The phrases are gh's and GitHub's, matched loosely so a reworded message still
 * lands in 'failed' rather than somewhere wrong.
 */
export function classifyGhFailure(stderr: string, code: string | number | null | undefined): GhFailureKind {
  if (code === 'ENOENT') return 'missing';
  const text = stderr.toLowerCase();
  if (/gh auth login|not logged in|authentication required|bad credentials|http 401/.test(text)) {
    return 'unauthenticated';
  }
  if (/rate limit|abuse detection|http 429|secondary rate/.test(text)) return 'rate-limited';
  if (/could not resolve to a (pullrequest|repository)|http 404|not found/.test(text)) return 'not-found';
  return 'failed';
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map(line => line.trim())
      .find(Boolean) ?? ''
  );
}

/**
 * The real runner: the user's own `gh`, with the PATH their terminal has (a Finder launch has
 * none of Homebrew's), and their own auth. No token is read, stored or passed by this app.
 *
 * GH_PROMPT_DISABLED keeps gh from ever waiting on a TTY that does not exist; NO_COLOR keeps
 * its stderr matchable.
 */
export const runGh: GhRunner = async (args, options = {}) => {
  const path = await resolveUserPath();
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      [...args],
      {
        cwd: options.cwd,
        timeout: GH_TIMEOUT_MS,
        maxBuffer: GH_MAX_BUFFER,
        env: { ...process.env, PATH: path, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' },
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        const kind = classifyGhFailure(String(stderr ?? ''), code);
        const detail = kind === 'missing' ? 'gh is not installed' : firstLine(String(stderr ?? '')) || error.message;
        reject(new GhError(kind, detail, String(stdout ?? '') || undefined));
      }
    );
  });
};

import { isAbsolute, resolve } from 'node:path';
import { realpathNearest, resolveWithinRoots } from './paths';
import type { ApprovalPrompt, ToolContext } from './types';

/**
 * The path as Windows resolves it: lower case, no `.` segments, and no `:stream:$DATA` suffix or
 * trailing dots and spaces on the file name. Applied on every platform, since a path can name a
 * file on a Windows volume (or WSL share) from anywhere.
 */
function windowsSpelling(path: string): string {
  const segments = path
    .replace(/\\/g, '/')
    .toLowerCase()
    .split('/')
    .filter(segment => segment !== '.');
  const name = (segments.pop() ?? '').replace(/:.*$/, '').replace(/[. ]+$/, '');
  return [...segments, name].join('/');
}

/**
 * Ported from opencode's default read rules, which mirror the Node.gitignore patterns: any path
 * ending `.env` or holding `.env.`, except a committed `.env.example`. A colon is read both as a
 * stream suffix and as the end of a `rev:`, `host:` or drive prefix; either reading counts.
 */
export function isEnvFile(path: string): boolean {
  return [path, path.slice(path.lastIndexOf(':') + 1)].some(reading => {
    const normalised = windowsSpelling(reading);
    return !normalised.endsWith('.env.example') && (normalised.endsWith('.env') || normalised.includes('.env.'));
  });
}

/** Whether a read of `requested` returns a `.env` file, by the name it was given or the file it resolves to. */
export async function readsEnvFile(requested: unknown, context: ToolContext): Promise<boolean> {
  if (typeof requested !== 'string' || !requested) return false;
  const base = context.workingDirectory;
  const lexical = isAbsolute(requested) || !base ? resolve(requested) : resolve(base, requested);
  return isEnvFile(lexical) || isEnvFile(await realpathNearest(lexical));
}

/** Refuses a path outside the granted folders before asking: a denial the user can click through is not one. */
export async function envReadPrompt(tool: string, requested: unknown, context: ToolContext): Promise<ApprovalPrompt> {
  const path = typeof requested === 'string' ? requested : '';
  await resolveWithinRoots(path, context.roots, context.workingDirectory);
  return {
    detail: `Read ${path}\n\nThis file usually holds secrets.`,
    key: `${tool}\x00${path}`,
    askInAuto: true,
  };
}

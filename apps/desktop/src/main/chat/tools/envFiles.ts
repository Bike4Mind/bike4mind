import { isAbsolute, resolve } from 'node:path';
import { realpathNearest, resolveWithinRoots } from './paths';
import type { ApprovalPrompt, ToolContext } from './types';

/**
 * The ways Windows can spell `path`: lower case, `.` segments dropped, `..` removing its parent
 * segment, and one spelling per colon-separated part of the final segment (a drive prefix, a
 * `rev:` or `host:` prefix, a `:stream` or `:stream:$DATA` suffix), each without trailing dots and
 * spaces. Applied on every platform, since a path can name a file on a Windows volume (or WSL share) from anywhere.
 */
function windowsSpellings(path: string): string[] {
  const segments: string[] = [];
  for (const segment of path.replace(/\\/g, '/').toLowerCase().split('/')) {
    if (segment === '..') segments.pop();
    else if (segment !== '.') segments.push(segment);
  }
  const last = segments.pop() ?? '';
  return last.split(':').map(part => [...segments, part.replace(/[. ]+$/, '')].join('/'));
}

/**
 * Ported from opencode's default read rules, which mirror the Node.gitignore patterns: any path
 * ending `.env` or holding `.env.`, except a committed `.env.example`. It is judged under every
 * spelling windowsSpellings gives, so a drive, revision or stream part cannot hide the name.
 */
export function isEnvFile(path: string): boolean {
  return windowsSpellings(path).some(
    spelling => !spelling.endsWith('.env.example') && (spelling.endsWith('.env') || spelling.includes('.env.'))
  );
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

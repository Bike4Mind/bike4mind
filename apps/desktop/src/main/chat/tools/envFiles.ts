import { isAbsolute, resolve } from 'node:path';
import { realpathNearest, resolveWithinRoots } from './paths';
import type { ApprovalPrompt, ToolContext } from './types';

/**
 * Ported from opencode's default read rules, which mirror the Node.gitignore patterns: any path
 * ending `.env` or holding `.env.`, except a committed `.env.example`.
 */
export function isEnvFile(path: string): boolean {
  const normalised = path.replace(/\\/g, '/');
  if (normalised.endsWith('.env.example')) return false;
  return normalised.endsWith('.env') || normalised.includes('.env.');
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

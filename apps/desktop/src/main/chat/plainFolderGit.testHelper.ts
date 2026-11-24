import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type * as HostGitArgs from '../git/hostGitArgs';

/** Reads project/git.ts makes that every caller already takes as "not a repository" when git fails. */
const REPOSITORY_READS = new Set(['rev-parse', 'symbolic-ref', 'show-ref']);

function insideRepository(directory: string): boolean {
  for (let current = directory; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return true;
    if (existsSync(join(current, 'HEAD')) && existsSync(join(current, 'objects'))) return true;
    if (dirname(current) === current) return false;
  }
}

function subcommandOf(args: readonly string[]): string | undefined {
  let index = 0;
  while (index < args.length && args[index].startsWith('-')) index += args[index] === '-c' ? 2 : 1;
  return args[index];
}

/**
 * hostGitArgs for `vi.mock`, with project/git.ts's repository reads in a folder outside any
 * repository failing without spawning git. A ChatService turn makes several of them per session,
 * and in a plain temp folder each spawn costs more than the rest of the turn. Calls that pass `-C`
 * (the shell scan, ownRepository) and every call inside a repository still run real git.
 */
export function skipGitOutsideRepositories(actual: typeof HostGitArgs): typeof HostGitArgs {
  return {
    ...actual,
    gitCommand: async (directory, args, platform) => {
      const subcommand = subcommandOf(args);
      if (subcommand && REPOSITORY_READS.has(subcommand) && !insideRepository(directory)) return null;
      return actual.gitCommand(directory, args, platform);
    },
  };
}

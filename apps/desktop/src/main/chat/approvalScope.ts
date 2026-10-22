import { homedir } from 'node:os';
import { isAbsolute, relative, sep } from 'node:path';
import type { ApprovalAlways } from './tools/types';

/**
 * What an "always allow" on a shell card will cover, in the words the card shows.
 *
 * Two strings because the shown one is capped and its paths abbreviated: a scope that grew with
 * the command is what made this prompt unreadable. `full` is the same list written out, for the
 * tooltip - an abbreviated path must not be the only account of what is being granted.
 */
export interface AlwaysScope {
  shown: string;
  full: string;
}

/** Past this many of either kind the rest becomes a "+N more"; the card has a line, not ten. */
const SHOWN = 3;

function capped(items: readonly string[]): string[] {
  if (items.length <= SHOWN) return [...items];
  return [...items.slice(0, SHOWN), `${items.length - SHOWN} more`];
}

/**
 * The shortest honest way to write a directory in a one-line summary.
 *
 * Relative only when the path is INSIDE the working directory: a `../../..` climb is longer than
 * the absolute path it replaces and says less about where it ended up.
 */
export function shortenDirectory(directory: string, workingDirectory?: string, home: string = homedir()): string {
  const candidates = [directory];
  if (workingDirectory) {
    const inside = relative(workingDirectory, directory);
    if (inside === '') candidates.push('.');
    else if (!inside.startsWith('..') && !isAbsolute(inside)) candidates.push(`.${sep}${inside}`);
  }
  if (home && directory === home) candidates.push('~');
  else if (home && directory.startsWith(home + sep)) candidates.push(`~${sep}${directory.slice(home.length + 1)}`);
  return candidates.reduce((best, each) => (each.length < best.length ? each : best));
}

/** The scope of a shell "always", capped and abbreviated for the card and written out for its title. */
export function describeAlways(
  always: ApprovalAlways,
  workingDirectory?: string,
  home: string = homedir()
): AlwaysScope | undefined {
  const patterns = [...new Set(always.commands.map(command => command.pattern))].map(pattern => `\`${pattern}\``);
  if (patterns.length === 0 && always.directories.length === 0) return undefined;
  const short = always.directories.map(directory => `${shortenDirectory(directory, workingDirectory, home)}${sep}*`);
  return {
    shown: [...capped(patterns), ...capped(short)].join(', '),
    full: [...patterns, ...always.directories.map(directory => `${directory}${sep}*`)].join(', '),
  };
}

import { homedir } from 'node:os';
import { isAbsolute, relative, sep } from 'node:path';
import { isWithin } from './tools/paths';
import type { ApprovalAlways } from './tools/types';
import { shownPath } from '../wsl/wslPath';

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

/** Past this many characters, or a line break, an exact command is cut on the card; `full` keeps it whole. */
const PATTERN_SHOWN = 60;

function shownPattern(pattern: string): string {
  const line = pattern.split('\n', 1)[0] ?? '';
  if (line === pattern && line.length <= PATTERN_SHOWN) return pattern;
  return `${line.slice(0, PATTERN_SHOWN).trimEnd()} ...`;
}

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
  if (always.ungranted?.length) return undefined;
  const patterns = [...new Set(always.commands.map(command => command.pattern))];
  if (patterns.length === 0 && always.directories.length === 0) return undefined;
  const short = always.directories.map(
    directory => `${shownPath(shortenDirectory(directory, workingDirectory, home))}${sep}*`
  );
  return {
    shown: [...capped(patterns.map(pattern => `\`${shownPattern(pattern)}\``)), ...capped(short)].join(', '),
    full: [
      ...patterns.map(pattern => `\`${pattern}\``),
      ...always.directories.map(directory => `${shownPath(directory)}${sep}*`),
    ].join(', '),
  };
}

/**
 * Why a shell card asks about `directories`, the folders outside the shared ones it still has to clear,
 * split by whether the command writes there; null when there are none.
 */
export function outsideFoldersReason(
  always: ApprovalAlways,
  directories: readonly string[],
  workingDirectory?: string,
  home: string = homedir()
): string | null {
  if (directories.length === 0) return null;
  const written = [...(always.writes ?? []), ...(always.writtenTrees ?? [])];
  // `writtenDirectories` also holds the folders a command only runs in or removes from, which no write path names;
  // a command that sends data out marks every folder there, so it says nothing about writing.
  const sends = always.commands.some(command => command.ask?.kinds.includes('outbound'));
  const writes = directories.filter(
    directory =>
      written.some(path => isWithin(directory, path)) || (!sends && always.writtenDirectories?.includes(directory))
  );
  const reaches = directories.filter(directory => !writes.includes(directory));
  const list = (folders: readonly string[]): string =>
    capped(folders.map(folder => shownPath(shortenDirectory(folder, workingDirectory, home)))).join(', ');
  return [
    ...(writes.length > 0 ? [`Writes outside the shared folders: ${list(writes)}.`] : []),
    ...(reaches.length > 0 ? [`Reaches outside the shared folders: ${list(reaches)}.`] : []),
  ].join(' ');
}

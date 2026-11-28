import { readdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, posix, sep } from 'node:path';
import { isValidSshAlias } from './sshCommand';

/** A directive that matters for listing hosts, in file order. */
export type SshConfigDirective = { kind: 'host'; names: string[] } | { kind: 'include'; paths: string[] };

/**
 * Splits a config line the way ssh does: the keyword ends at whitespace or `=`, arguments are
 * separated by whitespace, double quotes group an argument that holds spaces, and `#` outside
 * quotes ends the line.
 */
export function tokenizeSshConfigLine(line: string): { keyword: string; args: string[] } | null {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;
  const keywordMatch = /^([^\s=]+)\s*(?:=\s*|\s+|$)/.exec(trimmed);
  if (!keywordMatch) return null;
  const rest = trimmed.slice(keywordMatch[0].length);
  const args: string[] = [];
  const argument = /"([^"]*)"|(\S+)/g;
  for (let match = argument.exec(rest); match !== null; match = argument.exec(rest)) {
    // As OpenSSH 8.7+ reads it: an unquoted argument starting with `#` begins a trailing comment.
    if (match[2]?.startsWith('#')) break;
    args.push(match[1] ?? match[2]);
  }
  return { keyword: keywordMatch[1].toLowerCase(), args };
}

/**
 * The Host and Include directives of one file. A Match block holds no host names, and an Include
 * inside one only applies when the match does, so everything from a Match line to the next Host
 * or Match line is skipped.
 */
export function parseSshConfig(text: string): SshConfigDirective[] {
  const directives: SshConfigDirective[] = [];
  let inMatch = false;
  for (const line of text.split(/\r?\n/)) {
    const tokens = tokenizeSshConfigLine(line);
    if (!tokens) continue;
    if (tokens.keyword === 'match') {
      inMatch = true;
    } else if (tokens.keyword === 'host') {
      inMatch = false;
      directives.push({ kind: 'host', names: tokens.args });
    } else if (tokens.keyword === 'include' && !inMatch) {
      directives.push({ kind: 'include', paths: tokens.args });
    }
  }
  return directives;
}

/** A Host name that names one machine: no wildcard, no negation. */
export const isConcreteHostName = (name: string): boolean => !/[*?]/.test(name) && !name.startsWith('!');

const GLOB_CHARACTERS = /[*?[]/;

/** One path segment of a glob as a RegExp, with glob(3)'s rule that a wildcard never matches a leading dot. */
export function globSegmentPattern(segment: string): RegExp {
  let source = '';
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index];
    if (character === '*') source += '[^/]*';
    else if (character === '?') source += '[^/]';
    else if (character === '[') {
      const close = segment.indexOf(']', index + 2);
      if (close === -1) {
        source += '\\[';
        continue;
      }
      let body = segment.slice(index + 1, close);
      const negated = body.startsWith('!');
      if (negated) body = body.slice(1);
      source += `[${negated ? '^' : ''}${body.replace(/[\\\]^]/g, '\\$&')}]`;
      index = close;
    } else source += character.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  const leadingDot = segment.startsWith('.') ? '' : '(?!\\.)';
  return new RegExp(`^${leadingDot}${source}$`);
}

export type SshConfigFileSystem = {
  /** The file's text, or null when it cannot be read. */
  readFile(path: string): Promise<string | null>;
  /** The entries of a directory, or null when it cannot be read. */
  readdir(path: string): Promise<string[] | null>;
  /** The canonical path, so a file reached by two routes counts once; the path itself when it cannot be resolved. */
  realpath(path: string): Promise<string>;
};

const nodeFileSystem: SshConfigFileSystem = {
  readFile: path => readFile(path, 'utf8').catch(() => null),
  readdir: path => readdir(path).catch(() => null),
  realpath: path => realpath(path).catch(() => path),
};

/** The files a glob names, sorted as glob(3) sorts them. A path without a wildcard is returned as is. */
export async function expandGlob(pattern: string, fs: SshConfigFileSystem): Promise<string[]> {
  if (!GLOB_CHARACTERS.test(pattern)) return [pattern];
  const absolute = pattern.startsWith(sep) || pattern.startsWith('/');
  const segments = pattern.split(/[\\/]/).filter(segment => segment !== '');
  let matches = [absolute ? '/' : ''];
  for (const segment of segments) {
    const next: string[] = [];
    for (const base of matches) {
      if (!GLOB_CHARACTERS.test(segment)) {
        next.push(base === '' ? segment : posix.join(base, segment));
        continue;
      }
      const entries = await fs.readdir(base === '' ? '.' : base);
      if (!entries) continue;
      const matcher = globSegmentPattern(segment);
      for (const entry of [...entries].sort()) {
        if (matcher.test(entry)) next.push(base === '' ? entry : posix.join(base, entry));
      }
    }
    matches = next;
  }
  return matches;
}

/** ssh's own limit on nested Include. */
export const MAX_INCLUDE_DEPTH = 16;

export type SshConfigListing = {
  /** Concrete host aliases in the order the config names them, each once. */
  aliases: string[];
  /** Includes that loop or nest too deep, and names that cannot be used as an alias; for the log. */
  problems: string[];
};

export type ListSshHostsOptions = { home?: string; fs?: SshConfigFileSystem };

/**
 * The machines the user's `~/.ssh/config` names. Includes are followed (relative paths from
 * `~/.ssh`, `~` expanded, globs too), Match blocks are skipped, and only Host names without a
 * wildcard or negation are kept: a pattern is not a machine to connect to. A name that is not a
 * valid alias (see isValidSshAlias) is left out and reported. A missing config lists nothing.
 */
export async function listSshHosts(options: ListSshHostsOptions = {}): Promise<SshConfigListing> {
  const home = options.home ?? homedir();
  const fs = options.fs ?? nodeFileSystem;
  const sshDirectory = join(home, '.ssh');
  const seen = new Set<string>();
  const aliases: string[] = [];
  const problems: string[] = [];

  const resolveInclude = (path: string): string => {
    if (path === '~' || path.startsWith('~/')) return join(home, path.slice(1));
    return isAbsolute(path) ? path : join(sshDirectory, path);
  };

  const visit = async (path: string, stack: readonly string[]): Promise<void> => {
    const canonical = await fs.realpath(path);
    if (stack.includes(canonical)) {
      problems.push(`Include cycle at ${path}`);
      return;
    }
    if (stack.length >= MAX_INCLUDE_DEPTH) {
      problems.push(`Include nested deeper than ${MAX_INCLUDE_DEPTH} at ${path}`);
      return;
    }
    const text = await fs.readFile(path);
    if (text === null) return;
    const inside = [...stack, canonical];
    for (const directive of parseSshConfig(text)) {
      if (directive.kind === 'include') {
        for (const include of directive.paths) {
          for (const file of await expandGlob(resolveInclude(include), fs)) await visit(file, inside);
        }
        continue;
      }
      for (const name of directive.names) {
        if (!isConcreteHostName(name) || seen.has(name)) continue;
        seen.add(name);
        if (isValidSshAlias(name)) aliases.push(name);
        else problems.push(`Host ${JSON.stringify(name)} is not a name Desktop can connect with`);
      }
    }
  };

  await visit(join(sshDirectory, 'config'), []);
  return { aliases, problems };
}

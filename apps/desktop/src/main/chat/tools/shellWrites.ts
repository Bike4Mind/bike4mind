import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { Node } from 'web-tree-sitter';
import { gitArgumentPath, gitCommand, gitCommandEnv, hostGitArgs, quickGitTimeout } from '../../git/hostGitArgs';
import { wslLocation, wslUncPath } from '../../wsl/wslPath';
import { isWithin, resolveOperand } from './paths';
import { findOnPath, WINDOWS_ROOTED } from './userPath';
import { own } from '@shared/ownKeys';

/**
 * Paths a command rewrites in place: `files` are single files, `trees` are folders whose
 * contents may all have changed. Relative paths resolve against the command's folder, by Linux
 * rules in a WSL folder.
 */
export interface InPlaceWrites {
  files: string[];
  trees: string[];
  /** Whether what it writes may include symlinks: an extracted archive, an applied diff or a checkout. */
  links?: boolean;
  /** Whether it may write somewhere the scan cannot name. */
  unread?: boolean;
  /** The folder operand, as written, of a clone from another computer, whose tree the scan cannot list. */
  remote?: string;
}

const MAX_PATCH_BYTES = 2 * 1024 * 1024;

/** Short options whose value is the next word when nothing is attached. */
const AWK_VALUED = 'fvieEl';
const PATCH_VALUED = 'BDdFgioprVYz';
const TAR_VALUED = 'bCfFgHIKLNTVX';

const DECOMPRESSORS: Record<string, { always: boolean }> = {
  gunzip: { always: true },
  gzip: { always: false },
  bunzip2: { always: true },
  bzip2: { always: false },
  unxz: { always: true },
  xz: { always: false },
  unlzma: { always: true },
  lzma: { always: false },
  unzstd: { always: true },
  zstd: { always: false },
  uncompress: { always: true },
};
const COMPRESSED_SUFFIX: [RegExp, string][] = [
  [/\.(tgz|taz|tbz2?|txz|tzst)$/, '.tar'],
  [/\.(gz|z|Z|bz2|xz|lzma|zst)$/, ''],
];

/** Operands other than option values, with `--` ending the options. */
function operands(args: readonly string[], valued: string, leadingOnly = false): string[] {
  const out: string[] = [];
  let options = true;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (options && arg === '--') {
      options = false;
      continue;
    }
    if (options && arg.length > 1 && arg.startsWith('-')) {
      if (!arg.startsWith('--') && valued.includes(arg.at(-1) ?? '')) index++;
      continue;
    }
    if (leadingOnly) options = false;
    out.push(arg);
  }
  return out;
}

/** Value of a short option (`-dX`, `-d X`) or long one (`--directory=X`, `--directory X`). */
function optionValue(args: readonly string[], short: string | null, long: string | null): string | undefined {
  for (const [index, arg] of args.entries()) {
    if (long && arg === long) return args[index + 1];
    if (long && arg.startsWith(`${long}=`)) return arg.slice(long.length + 1);
    if (short && arg === short) return args[index + 1];
    if (short && arg.startsWith(short) && !arg.startsWith('--')) return arg.slice(short.length);
  }
  return undefined;
}

function shortCluster(arg: string): string {
  return arg.length > 1 && arg.startsWith('-') && !arg.startsWith('--') ? arg.slice(1) : '';
}

const hasGlob = (path: string): boolean => /[?*[]/.test(path);
/** A glob's fixed leading folder, so `src/*.sh` counts as all of `src`. */
function treeOf(path: string): string {
  if (!hasGlob(path)) return path;
  const prefix = path.slice(0, /[?*[]/.exec(path)?.index);
  return prefix.endsWith('/') ? prefix.slice(0, -1) || '/' : dirname(prefix);
}

/** An archive member under the folder it is extracted to, joined with `/` so a WSL folder's command reads it by Linux rules. */
const memberIn = (base: string, member: string): string => `${base}/${treeOf(member)}`;

interface EditOptions {
  /** Options that give the program, so the first operand is a file. */
  script: string;
  scriptLong: string[];
  valued: string;
  valuedLong: string[];
  /** Short options whose value is always attached (`perl -Mstrict`). */
  attached: string;
}

/**
 * The files a sed, perl or ruby run edits in place, or none without `-i`. A short `i` takes the
 * rest of its cluster as the backup suffix (`-ie` is suffix `e`), and the first operand is the
 * program unless an option gave one.
 */
function editedFiles(args: readonly string[], options: EditOptions, stopAtOperand: boolean): string[] {
  let inPlace = false;
  let scriptGiven = false;
  const words: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') {
      words.push(...args.slice(index + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const [name, value] = arg.slice(2).split(/=(.*)/s);
      if (name.startsWith('in-place')) inPlace = true;
      if (options.scriptLong.includes(name)) scriptGiven = true;
      if (value === undefined && options.valuedLong.includes(name)) index++;
      continue;
    }
    if (arg.length > 1 && arg.startsWith('-')) {
      for (let at = 1; at < arg.length; at++) {
        const letter = arg[at];
        if (letter === 'i') {
          inPlace = true;
          break;
        }
        if (options.script.includes(letter)) scriptGiven = true;
        if (options.valued.includes(letter)) {
          if (at === arg.length - 1) index++;
          break;
        }
        if (options.attached.includes(letter)) break;
      }
      continue;
    }
    words.push(arg);
    if (stopAtOperand) {
      words.push(...args.slice(index + 1));
      break;
    }
  }
  // BSD `sed -i ''` passes an empty suffix word.
  const operands = words.filter(Boolean);
  if (!inPlace) return [];
  return scriptGiven ? operands : operands.slice(1);
}

const SED: EditOptions = {
  script: 'ef',
  scriptLong: ['expression', 'file'],
  valued: 'efl',
  valuedLong: ['expression', 'file', 'line-length'],
  attached: '',
};
const SCRIPT: EditOptions = { script: 'eE', scriptLong: [], valued: 'eE', valuedLong: [], attached: '0CdDFIlmMrx' };

function awkFiles(args: readonly string[]): string[] {
  let inPlace = false;
  let scriptGiven = false;
  const words: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') {
      words.push(...args.slice(index + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const [name, value] = arg.slice(2).split(/=(.*)/s);
      const next = value ?? args[index + 1];
      if (name === 'include' && next === 'inplace') inPlace = true;
      if (['file', 'source', 'exec'].includes(name)) scriptGiven = true;
      if (value === undefined && ['file', 'source', 'exec', 'include', 'assign', 'load'].includes(name)) index++;
      continue;
    }
    if (arg.length > 1 && arg.startsWith('-')) {
      const letter = arg[1];
      const value = arg.length > 2 ? arg.slice(2) : args[index + 1];
      if (letter === 'i' && value === 'inplace') inPlace = true;
      if ('feE'.includes(letter)) scriptGiven = true;
      if (AWK_VALUED.includes(letter) && arg.length === 2) index++;
      continue;
    }
    words.push(arg);
  }
  if (!inPlace) return [];
  return scriptGiven ? words : words.slice(1);
}

function inPlaceEdit(program: string, args: readonly string[]): string[] {
  if (program === 'sed') return editedFiles(args, SED, false);
  if (program === 'perl' || program === 'ruby') return editedFiles(args, SCRIPT, true);
  if (program === 'awk' || program === 'gawk') return awkFiles(args);
  return [];
}

/** tar long options that take a value in the next word. */
const TAR_VALUED_LONG = [
  'file',
  'files-from',
  'exclude-from',
  'blocking-factor',
  'directory',
  'to-command',
  'use-compress-program',
  'info-script',
  'new-volume-script',
  'rsh-command',
  'rmt-command',
  'transform',
  'xform',
  'checkpoint-action',
  'index-file',
];

/** tar options that run a program, rename members or write a file of their own, so what it writes is unread. */
const TAR_UNREAD_LONG = TAR_VALUED_LONG.slice(5);

/**
 * GNU and BSD tar, including the old `tar xzf a.tgz` form whose letters take values in order; null when an
 * option makes what it writes unreadable. A long option is matched by any prefix, as getopt_long takes one.
 */
function tarTrees(args: readonly string[]): string[] | null {
  return tarExtraction(args)?.trees ?? null;
}

/** What `tarTrees` reads, with the archive an extraction reads and how many leading components it strips. */
function tarExtraction(
  args: readonly string[]
): { trees: string[]; archive?: string; directory: string; strip: number; whole: boolean } | null {
  const rest = [...args];
  let extract = false;
  let absolute = false;
  let unread = false;
  let directory: string | undefined;
  let archive: string | undefined;
  let strip = 0;
  const members: string[] = [];
  const takeShort = (letters: string, attached: boolean): void => {
    for (let index = 0; index < letters.length; index++) {
      const letter = letters[index];
      if (letter === 'x') extract = true;
      if (letter === 'P') absolute = true;
      if (letter === 'I' || letter === 'F') unread = true;
      if (!TAR_VALUED.includes(letter)) continue;
      const tail = letters.slice(index + 1);
      const value = attached && tail ? tail : rest.shift();
      if (letter === 'C') directory = value;
      if (letter === 'f') archive = value;
      if (attached) return;
    }
  };
  const first = rest[0];
  if (first !== undefined && /^[A-Za-z]+$/.test(first)) takeShort(rest.shift() as string, false);
  while (rest.length > 0) {
    const arg = rest.shift() as string;
    if (arg === '--') {
      members.push(...rest.splice(0));
    } else if (arg.startsWith('--')) {
      const [name = '', value] = arg.slice(2).split(/=(.*)/s);
      const names = (option: string): boolean => name.length >= 2 && option.startsWith(name);
      if (names('extract') || names('get')) extract = true;
      if (names('absolute-names')) absolute = true;
      if (TAR_UNREAD_LONG.some(names)) unread = true;
      if (name.length >= 3 && 'directory'.startsWith(name)) directory = value ?? rest.shift();
      else if (name.length >= 3 && 'strip-components'.startsWith(name)) strip = Number(value ?? rest.shift());
      else if (name === 'file') archive = value ?? rest.shift();
      else if (value === undefined && TAR_VALUED_LONG.some(names)) rest.shift();
    } else if (arg.length > 1 && arg.startsWith('-')) {
      takeShort(arg.slice(1), true);
    } else {
      members.push(arg);
    }
  }
  if (unread) return null;
  const base = directory ?? '.';
  if (!extract) return { trees: [], directory: base, strip, whole: false };
  // Members keep a leading `/` and `..`, so the archive may write anywhere.
  if (absolute) return { trees: ['/'], directory: base, strip, whole: false };
  const trees = members.length > 0 ? members.map(member => memberIn(base, member)) : [base];
  return { trees, ...(archive === undefined ? {} : { archive }), directory: base, strip, whole: true };
}

/** Archive members an extraction lists before the scan reads them as paths instead of a whole tree. */
const LISTED_MEMBERS = 10_000;

/** The granted roots of the scan running now, for the git calls that do not take them. */
const scanRoots = new AsyncLocalStorage<readonly string[]>();

/** Runs `scan` with `roots` as the granted roots git is found outside of (see pathOutside). */
export function withGrantedRoots<T>(roots: readonly string[], scan: () => Promise<T>): Promise<T> {
  return scanRoots.run(roots, scan);
}

/**
 * PATH with only its absolute entries outside every granted root, physically as well as by name, so neither a
 * program the scan starts nor a filter that program starts (tar's `gzip -d`) is one a granted folder holds.
 */
async function pathOutside(roots: readonly string[]): Promise<string> {
  const windows = process.platform === 'win32';
  const separator = windows ? ';' : ':';
  const realRoots = await Promise.all(roots.map(root => realpath(root).catch(() => root)));
  const granted = [...roots, ...realRoots];
  const kept: string[] = [];
  for (const raw of (process.env.PATH ?? '').split(separator)) {
    const entry = raw.trim().replace(/^"(.*)"$/, '$1');
    if (windows ? !WINDOWS_ROOTED.test(entry) : !isAbsolute(entry)) continue;
    const places = [entry, await realpath(entry).catch(() => entry)];
    if (!places.some(place => granted.some(root => isWithin(root, place)))) kept.push(entry);
  }
  return kept.join(separator);
}

/** Runs a listing program from its own folder with `path` as its only PATH, so it starts nothing from the project. */
function runListing(
  file: string,
  args: readonly string[],
  path: string,
  cwd = dirname(file),
  extra: NodeJS.ProcessEnv = {}
): Promise<string | null> {
  const env: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(process.env)) if (key.toUpperCase() !== 'PATH') env[key] = process.env[key];
  Object.assign(env, extra);
  env.PATH = path;
  return new Promise(done => {
    execFile(file, args, { cwd, env, timeout: 2000, maxBuffer: GIT_OUTPUT_BYTES, windowsHide: true }, (error, stdout) =>
      done(error ? null : stdout)
    );
  });
}

/** Whether each tar on PATH is GNU tar, which alone reads `host:file` as a remote archive and takes `--force-local`. */
const gnuTar = new Map<string, Promise<boolean>>();

/**
 * One archive listing, from the program found on PATH outside every granted root: a member name per line, or a long
 * listing whose lines open with each member's type. Null for stdin, a name read as an option, or an archive on
 * another host, which the scan never opens (`host:file` for tar, a `\\host\share` or `//host/` path).
 */
async function listArchive(
  cwd: string,
  program: string,
  archive: string,
  args: readonly string[],
  roots: readonly string[]
): Promise<string | null> {
  if (archive.startsWith('-') || /^[\\/]{2}/.test(archive)) return null;
  if (/^[^/\\]*:/.test(archive.replace(/^[A-Za-z]:[\\/]/, ''))) return null;
  const path = await pathOutside(roots);
  const file = await findOnPath(program, path);
  if (file === null) return null;
  const absolute = resolve(cwd, archive);
  if (program === 'unzip') return runListing(file, [...args, '--', absolute], path);
  let gnu = gnuTar.get(file);
  if (gnu === undefined) {
    gnu = runListing(file, ['--version'], path).then(version => /GNU tar/.test(version ?? ''));
    gnuTar.set(file, gnu);
  }
  return runListing(file, [...args, ...((await gnu) ? ['--force-local'] : []), `--file=${absolute}`], path);
}

/** find tests that only select by name, path or type, with the value each takes; a last `-print` is dropped. */
const FIND_TESTS = /^-(name|iname|path|ipath|wholename|iwholename|type)$/;
/** Tests that only narrow what find prints, so without `-o`, `!` or a group dropping one prints more, never other. */
const FIND_NARROWS = /^-(empty|readable|writable|executable|nouser|nogroup|xdev|mount)$/;
const FIND_NARROWS_VALUED =
  /^-(mtime|mmin|atime|amin|ctime|cmin|used|size|newer|anewer|cnewer|newer[aBcmt]{2}|perm|user|group|uid|gid|links|inum|samefile|regex|iregex|fstype)$/;
const FIND_LISTED = 1000;

/**
 * What a POSIX `find` over `folders` (from `cwd`) prints with the same tests and `select` ANDed on, which the
 * system find lists so a large tree costs no walk here; null when a test is not one it reads, find fails, or it
 * lists too many. With `-print` last, the rest selects all it prints and more, as with `A -o B -print`.
 */
async function findSelected(
  cwd: string,
  folders: readonly string[],
  tests: readonly string[],
  roots: readonly string[],
  select: readonly string[]
): Promise<string[] | null> {
  const globals: string[] = [];
  const kept: string[] = [];
  const anded = !tests.some(test => ['!', '-not', '(', ')', '-o', '-or', ','].includes(test));
  for (let index = 0; index < tests.length; index++) {
    const test = tests[index] as string;
    const value = tests[index + 1];
    if (/^-(maxdepth|mindepth)$/.test(test) && value !== undefined && /^\d+$/.test(value)) {
      globals.push(test, value);
      index++;
    } else if (test === '-depth') {
      // Kept, as it turns `-prune` off.
      globals.push(test);
    } else if (FIND_TESTS.test(test) && value !== undefined) {
      kept.push(test, value);
      index++;
    } else if (anded && FIND_NARROWS.test(test)) continue;
    else if (anded && FIND_NARROWS_VALUED.test(test) && value !== undefined) index++;
    else if (['!', '-not', '(', ')', '-o', '-or', '-a', '-and', '-prune'].includes(test)) kept.push(test);
    else if (!((test === '-print' || test === '-print0') && index === tests.length - 1)) return null;
  }
  if (process.platform === 'win32') return null;
  const path = await pathOutside(roots);
  const file = await findOnPath('find', path);
  if (file === null) return null;
  const starts = folders.map(folder =>
    folder.startsWith('-') || folder.startsWith('(') || folder === '!' ? `./${folder}` : folder
  );
  const expression = kept.length > 0 ? ['(', ...kept, ')'] : [];
  // In the C locale `[[:space:]]` is the bytes xargs splits at.
  const listed = await runListing(file, ['-P', ...starts, ...globals, ...expression, ...select, '-print0'], path, cwd, {
    LC_ALL: 'C',
  });
  const found = listed?.split('\0').filter(entry => entry !== '') ?? null;
  return found === null || found.length > FIND_LISTED ? null : found.map(entry => resolve(cwd, entry));
}

/** The folders `find` over `folders` prints with `tests` (see findSelected). */
export function findFolders(
  cwd: string,
  folders: readonly string[],
  tests: readonly string[],
  roots: readonly string[]
): Promise<string[] | null> {
  return findSelected(cwd, folders, tests, roots, ['-type', 'd']);
}

/**
 * The paths `find` over `folders` prints with `tests` (see findSelected), less `select`, that xargs would not pass
 * whole: those holding a blank, a quote or a backslash, or a part starting with `-`.
 */
export function findOddPaths(
  cwd: string,
  folders: readonly string[],
  tests: readonly string[],
  roots: readonly string[],
  select: readonly string[] = []
): Promise<string[] | null> {
  const odd = ['*[[:space:]]*', "*'*", '*"*', '*\\\\*', '*/-*'].flatMap((pattern, index) => [
    ...(index > 0 ? ['-o'] : []),
    '-path',
    pattern,
  ]);
  return findSelected(cwd, folders, tests, roots, [...select, '(', ...odd, ')']);
}

/**
 * Whether a path git prints without `-z` may reach xargs's program as other words: git quotes a byte outside
 * printable ASCII, xargs splits at blanks and quotes, and a part starting with `-` may read as an option.
 */
export const oddForXargs = (path: string): boolean => /[^\x21-\x7e]|['"\\]|(^|\/)-/.test(path);

/** The links `find` over `folders` prints with `tests` (see findSelected). */
export function findLinks(
  cwd: string,
  folders: readonly string[],
  tests: readonly string[],
  roots: readonly string[]
): Promise<string[] | null> {
  return findSelected(cwd, folders, tests, roots, ['-type', 'l']);
}

/** The settings files (`.claude/settings*`) `find` over `folders` prints with `tests` (see findSelected). */
export async function findSettings(
  cwd: string,
  folders: readonly string[],
  tests: readonly string[],
  roots: readonly string[]
): Promise<string[] | null> {
  const named = await findSelected(cwd, folders, tests, roots, ['-iname', 'settings*']);
  return named?.filter(isSettingsPath) ?? null;
}

/** Whether `path` names a settings file directly in a `.claude` folder, in any case. */
export const isSettingsPath = (path: string): boolean => /(^|[\\/])\.claude[\\/]settings[^\\/]*$/i.test(path);

/**
 * The files an extraction into a folder holding `.claude` writes, from a listing of the archive: null when it
 * cannot be listed or a member is a link, is absolute, climbs with `..` or names a `.claude` folder.
 */
async function extractedMembers(
  program: string,
  args: readonly string[],
  cwd: string,
  roots: readonly string[]
): Promise<string[] | null> {
  if (wslLocation(cwd) !== null) return null;
  let names: string[];
  let types: string[];
  let directory: string;
  let strip = 0;
  if (program === 'unzip') {
    const archive = args.find(arg => !arg.startsWith('-') && arg !== optionValue(args, '-d', null));
    directory = optionValue(args, '-d', null) ?? '.';
    const listed = archive === undefined ? null : await listArchive(cwd, 'unzip', archive, ['-Z'], roots);
    if (listed === null) return null;
    const lines = listed.split('\n').filter(line => /^[-dlbcps][-rwxsStT]{9}\s/.test(line));
    const parsed = lines.map(line => /^\S{10}\s+\S+\s+\S+\s+\d+\s+\S+\s+\S+\s+\S+\s+\S+\s(.*)$/.exec(line)?.[1]);
    if (parsed.some(name => name === undefined)) return null;
    names = parsed as string[];
    types = lines.map(line => line[0] as string);
  } else {
    const read = tarExtraction(args);
    if (!read?.whole || read.archive === undefined || !Number.isInteger(read.strip) || read.strip < 0) return null;
    ({ directory, strip } = read);
    const [plain, long] = await Promise.all([
      listArchive(cwd, program, read.archive, ['-t'], roots),
      listArchive(cwd, program, read.archive, ['-tv'], roots),
    ]);
    if (plain === null || long === null) return null;
    names = plain.split('\n').filter(line => line !== '');
    types = long
      .split('\n')
      .filter(line => line !== '')
      .map(line => line[0] as string);
    if (types.length !== names.length) return null;
  }
  if (names.length > LISTED_MEMBERS) return null;
  const files: string[] = [];
  for (const [index, name] of names.entries()) {
    const parts = name.split('/').slice(strip);
    if (!['-', 'd'].includes(types[index] ?? '') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return null;
    if (name.split(/[\\/]/).some(part => part === '..' || part.toLowerCase() === '.claude')) return null;
    if (parts.length > 0 && parts.join('/') !== '') files.push(resolveOperand(cwd, directory, parts.join('/')));
  }
  return files;
}

function unzipTrees(args: readonly string[]): string[] {
  if (args.some(arg => /[lptcZz]/.test(shortCluster(arg).replace(/d.*$/, '')))) return [];
  // `-:` keeps `../` in member names.
  if (args.some(arg => shortCluster(arg).replace(/d.*$/, '').includes(':'))) return ['/'];
  const directory = optionValue(args, '-d', null);
  const words: string[] = [];
  let excluding = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '-x') excluding = true;
    else if (arg.startsWith('-')) {
      excluding = false;
      if (arg === '-d' || arg === '-P') index++;
    } else if (!excluding) words.push(arg);
  }
  const base = directory ?? '.';
  const members = words.slice(1);
  return members.length > 0 ? members.map(member => memberIn(base, member)) : [base];
}

function decompressed(program: string, args: readonly string[]): string[] {
  const shorts = args.map(shortCluster).join('');
  const decompress =
    own(DECOMPRESSORS, program)?.always ||
    shorts.includes('d') ||
    args.some(arg => arg === '--decompress' || arg === '--uncompress');
  const toStdout = /[ctl]/.test(shorts) || args.some(arg => arg === '--stdout' || arg === '--to-stdout');
  if (!decompress || toStdout) return [];
  const output = program.endsWith('zstd') ? optionValue(args, '-o', null) : undefined;
  if (output) return [output];
  return operands(args, program.endsWith('zstd') ? 'o' : '').flatMap(path => {
    const match = COMPRESSED_SUFFIX.find(([suffix]) => suffix.test(path));
    return match ? [path.replace(match[0], match[1])] : [];
  });
}

/** Every path a diff header names, at every `-p` strip level, since the level is not always on the command line. */
export function patchedPaths(diff: string): string[] {
  const paths = new Set<string>();
  const add = (raw: string): void => {
    const path = raw.replace(/^"(.*)"$/, '$1');
    if (!path || path === '/dev/null') return;
    const parts = path.split('/').filter(Boolean);
    for (let index = 0; index < parts.length; index++) paths.add(parts.slice(index).join('/'));
    if (isAbsolute(path)) paths.add(path);
  };
  for (const line of diff.split('\n')) {
    const git = /^diff --git ("[^"]*"|\S+) ("[^"]*"|\S+)/.exec(line);
    if (git) {
      add(git[1]);
      add(git[2]);
      continue;
    }
    const header = /^(?:\+\+\+|---|\*\*\*|Index:|rename to|copy to) +([^\t\n]+)/.exec(line);
    if (header) add(header[1].trim());
  }
  return [...paths];
}

/** The text a command reads on standard input from a `<` file, a heredoc or a here-string. */
async function stdinText(node: Node, cwd: string): Promise<string | null> {
  const parent = node.parent;
  if (parent?.type !== 'redirected_statement') return null;
  for (const child of parent.namedChildren) {
    if (!child) continue;
    if (child.type === 'heredoc_redirect') {
      return child.descendantsOfType('heredoc_body')[0]?.text ?? null;
    }
    if (child.type === 'herestring_redirect') return child.namedChildren.at(-1)?.text ?? null;
    if (child.type === 'file_redirect' && child.text.trimStart().startsWith('<')) {
      const target = child.childForFieldName('destination')?.text;
      if (target) return readSmall(resolveOperand(cwd, target.replace(/^(['"])(.*)\1$/, '$2')));
    }
  }
  return null;
}

async function readSmall(path: string): Promise<string | null> {
  if (path.includes('$') || path.includes('`')) return null;
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size > MAX_PATCH_BYTES) return null;
  return readFile(path, 'utf8').catch(() => null);
}

async function patchWrites(args: readonly string[], node: Node, cwd: string): Promise<InPlaceWrites> {
  if (args.includes('--dry-run')) return { files: [], trees: [] };
  const directory = optionValue(args, '-d', '--directory') ?? '.';
  const [original, patchFile] = operands(args, PATCH_VALUED);
  const output = optionValue(args, '-o', '--output');
  // patch moves into `-d` before it reads its own arguments; a `<` redirect is the shell's.
  const files = [original, output].filter((path): path is string => !!path && path !== '-');
  const source = optionValue(args, '-i', '--input') ?? patchFile;
  const diff = source ? await readSmall(resolveOperand(cwd, directory, source)) : await stdinText(node, cwd);
  const named = diff ? patchedPaths(diff) : [];
  return {
    files: [...files, ...named].map(path => resolveOperand(cwd, directory, path)),
    trees: named.length === 0 && files.length === 0 ? [directory] : [],
  };
}

/** The folder holding `.git` at or above `directory`, else null. */
export async function findRepositoryRoot(directory: string): Promise<string | null> {
  for (let current = directory; ; current = dirname(current)) {
    if (await stat(join(current, '.git')).catch(() => null)) return current;
    if (dirname(current) === current) return null;
  }
}

/** The folder holding `.git` at or above `directory`, else `directory` itself. */
export async function repositoryRoot(directory: string): Promise<string> {
  return (await findRepositoryRoot(directory)) ?? directory;
}

const GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * A git query run in `directory` with hooks and fsmonitor off and no inherited GIT_* setting, so it reads the
 * repository the folder names. Every query is plumbing that reads no work-tree file, and attributes are read from
 * the empty tree with no lazy fetch, so no filter, textconv or fetch the repository configures runs. Its exit code
 * and output; null when it could not run, timed out or overran.
 */
async function gitRun(directory: string, args: readonly string[]): Promise<{ code: number; stdout: string } | null> {
  const inherited = await gitCommandEnv(directory);
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(inherited ?? process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_'))
  );
  // GIT_ALLOW_PROTOCOL=none also stops a lazy fetch on git older than GIT_NO_LAZY_FETCH (2.39.4 and 2.45.1).
  const settings = { GIT_ATTR_SOURCE: EMPTY_TREE, GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: 'none' };
  Object.assign(env, settings);
  // Through wsl.exe only the variables WSLENV names reach Linux git.
  if (inherited) env.WSLENV = [env.WSLENV, ...Object.keys(settings)].filter(Boolean).join(':');
  const nullDevice = wslLocation(directory) || process.platform !== 'win32' ? '/dev/null' : 'NUL';
  const command = await gitCommand(
    directory,
    hostGitArgs(
      [
        '--no-optional-locks',
        '-c',
        `core.attributesFile=${nullDevice}`,
        '-C',
        gitArgumentPath(directory, directory),
        ...args,
      ],
      directory
    )
  );
  if (!command) return null;
  if (!inherited) {
    // Bare `git` would resolve through this process's PATH from the project folder.
    const path = await pathOutside(scanRoots.getStore() ?? []);
    const file = await findOnPath('git', path);
    if (file === null) return null;
    for (const name of Object.keys(env)) if (name.toUpperCase() === 'PATH') delete env[name];
    env.PATH = path;
    command.file = file;
  }
  return new Promise(done => {
    execFile(
      command.file,
      command.args,
      { cwd: command.cwd, env, timeout: quickGitTimeout(inherited), maxBuffer: GIT_OUTPUT_BYTES, windowsHide: true },
      (error, stdout) => {
        if (!error) done({ code: 0, stdout });
        else done(typeof error.code === 'number' && !error.killed ? { code: error.code, stdout } : null);
      }
    );
  });
}

/** Whether the branch checked out in `cwd` tracks an upstream, which a bare `git rebase` or `git merge` needs; null when git cannot tell. */
async function upstreamTracked(cwd: string): Promise<boolean | null> {
  const tracked = await gitRun(cwd, ['rev-parse', '--verify', '-q', '@{u}']);
  return tracked === null ? null : tracked.code === 0;
}

/** The output of a git query; null on an error, a timeout or an overrun. */
async function gitQuery(directory: string, args: readonly string[]): Promise<string | null> {
  const result = await gitRun(directory, args);
  return result?.code === 0 ? result.stdout : null;
}

/** What `git rev-parse --show-toplevel` prints in `directory` (a Linux path in a WSL folder), or null when git fails. */
export async function gitToplevel(directory: string): Promise<string | null> {
  const printed = (await gitQuery(directory, ['rev-parse', '--show-toplevel']))?.replace(/\r?\n$/, '');
  return printed || null;
}

/** A git option grammar: short flags, short options with a value, long flags, long options with a value. */
interface GitGrammar {
  letters?: string;
  valued?: string;
  flags?: readonly string[];
  long?: readonly string[];
}

interface GitArgs {
  positionals: string[];
  /** Options given, by long name or letter, with their values. */
  given: Map<string, string | true>;
  /** Words after `--`. */
  paths: string[];
  /** An option outside the grammar, which the scan cannot read. */
  unknown: boolean;
}

/** Reads `args` as git's parse-options does, taking a long option's unique abbreviation for it. */
function gitArgs(args: readonly string[], grammar: GitGrammar): GitArgs {
  const read: GitArgs = { positionals: [], given: new Map(), paths: [], unknown: false };
  const names = [...(grammar.flags ?? []), ...(grammar.long ?? [])];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    if (arg === '--') {
      read.paths = args.slice(index + 1);
      break;
    }
    if (arg.startsWith('--')) {
      const [given = '', value] = arg.slice(2).split(/=(.*)/s);
      const abbreviated = names.filter(name => name.startsWith(given));
      const name = names.includes(given) ? given : abbreviated.length === 1 ? abbreviated[0] : undefined;
      if (given === '' || name === undefined) {
        read.unknown = true;
        continue;
      }
      read.given.set(name, value ?? ((grammar.long ?? []).includes(name) ? (args[++index] ?? '') : true));
    } else if (arg.length > 1 && arg.startsWith('-')) {
      for (let at = 1; at < arg.length; at++) {
        const letter = arg[at] as string;
        if ((grammar.valued ?? '').includes(letter)) {
          read.given.set(letter, arg.slice(at + 1) || (args[++index] ?? ''));
          break;
        }
        if (!(grammar.letters ?? '').includes(letter)) read.unknown = true;
        read.given.set(letter, true);
      }
    } else {
      read.positionals.push(arg);
    }
  }
  return read;
}

const has = (read: GitArgs, ...names: string[]): boolean => names.some(name => read.given.has(name));

/** The options of the git subcommands that write the work tree from a commit; any other option leaves the command unread. */
const TREE_GRAMMARS: Readonly<Record<string, GitGrammar>> = {
  checkout: {
    letters: 'qfmtl',
    valued: 'bB',
    flags: [
      'quiet',
      'force',
      'merge',
      'detach',
      'track',
      'no-track',
      'guess',
      'no-guess',
      'progress',
      'no-progress',
      'ignore-other-worktrees',
      'overwrite-ignore',
      'no-overwrite-ignore',
    ],
    long: ['conflict'],
  },
  switch: {
    letters: 'qfmtd',
    valued: 'cC',
    flags: [
      'quiet',
      'force',
      'discard-changes',
      'merge',
      'detach',
      'track',
      'no-track',
      'guess',
      'no-guess',
      'progress',
      'no-progress',
      'ignore-other-worktrees',
    ],
    long: ['create', 'force-create', 'conflict'],
  },
  merge: {
    letters: 'qvn',
    valued: 'mFsX',
    flags: [
      'commit',
      'no-commit',
      'no-edit',
      'ff',
      'no-ff',
      'ff-only',
      'squash',
      'no-squash',
      'stat',
      'no-stat',
      'log',
      'no-log',
      'quiet',
      'verbose',
      'progress',
      'no-progress',
      'signoff',
      'no-signoff',
      'verify',
      'no-verify',
      'allow-unrelated-histories',
      'autostash',
      'no-autostash',
      'overwrite-ignore',
      'rerere-autoupdate',
      'no-rerere-autoupdate',
    ],
    long: ['message', 'file', 'strategy', 'strategy-option', 'cleanup', 'into-name'],
  },
  'cherry-pick': {
    letters: 'nxs',
    valued: 'mX',
    flags: [
      'no-commit',
      'signoff',
      'ff',
      'allow-empty',
      'allow-empty-message',
      'keep-redundant-commits',
      'rerere-autoupdate',
      'no-rerere-autoupdate',
    ],
    long: ['mainline', 'strategy', 'strategy-option', 'cleanup', 'empty'],
  },
  revert: {
    letters: 'ns',
    valued: 'mX',
    flags: ['no-commit', 'signoff', 'reference', 'rerere-autoupdate', 'no-rerere-autoupdate'],
    long: ['mainline', 'strategy', 'strategy-option', 'cleanup'],
  },
  reset: {
    letters: 'qN',
    flags: ['quiet', 'soft', 'mixed', 'hard', 'merge', 'keep', 'intent-to-add', 'refresh', 'no-refresh'],
  },
  'read-tree': {
    letters: 'muinv',
    flags: ['reset', 'trivial', 'aggressive', 'empty', 'no-sparse-checkout', 'quiet'],
    long: ['exclude-per-directory'],
  },
  'checkout-index': {
    letters: 'afnquz',
    flags: ['all', 'force', 'no-create', 'quiet', 'index', 'temp'],
    long: ['stage'],
  },
  clone: {
    letters: 'qvlns',
    valued: 'bo',
    flags: [
      'quiet',
      'verbose',
      'progress',
      'no-progress',
      'local',
      'no-local',
      'no-hardlinks',
      'shared',
      'no-checkout',
      'bare',
      'mirror',
      'single-branch',
      'no-single-branch',
      'tags',
      'no-tags',
      'reject-shallow',
      'no-reject-shallow',
      'dissociate',
    ],
    long: ['branch', 'origin', 'depth', 'shallow-since', 'shallow-exclude', 'filter', 'reference'],
  },
  rebase: {
    letters: 'qvfn',
    valued: 'sX',
    flags: [
      'quiet',
      'verbose',
      'autostash',
      'no-autostash',
      'fork-point',
      'no-fork-point',
      'force-rebase',
      'no-ff',
      'stat',
      'no-stat',
      'verify',
      'no-verify',
      'signoff',
      'keep-empty',
      'no-keep-empty',
      'reapply-cherry-picks',
      'no-reapply-cherry-picks',
      'update-refs',
      'no-update-refs',
      'rebase-merges',
      'no-rebase-merges',
    ],
    long: ['onto', 'strategy', 'strategy-option', 'empty', 'whitespace'],
  },
  stash: {
    letters: 'kuaqS',
    valued: 'm',
    flags: ['keep-index', 'no-keep-index', 'include-untracked', 'all', 'quiet', 'staged', 'index'],
    long: ['message'],
  },
  am: {
    letters: '3skcqu',
    valued: 'pC',
    flags: [
      'signoff',
      'keep',
      'keep-non-patch',
      'keep-cr',
      'no-keep-cr',
      'scissors',
      'no-scissors',
      'quiet',
      'utf8',
      'no-utf8',
      '3way',
      'no-3way',
      'committer-date-is-author-date',
      'ignore-date',
      'ignore-space-change',
      'ignore-whitespace',
      'reject',
    ],
    long: ['whitespace', 'exclude', 'include', 'patch-format', 'quoted-cr', 'empty'],
  },
  clean: { letters: 'dfxXnq', valued: 'e', flags: ['force', 'dry-run', 'quiet'], long: ['exclude'] },
};

/** A revision the scan hands to git as one: no option, expansion or space can hide in it. */
const REVISION = /^[\w./@{}^~:+-]+$/;

/** Work-tree contents staged into the index earlier in a script, which a later `git checkout-index` writes out. */
export interface GitScript {
  staged: string[];
  /** Something earlier set the index to what the scan cannot name (`git update-index`). */
  unknownIndex: boolean;
  /** Something earlier may have moved HEAD, a ref, an upstream or config, so a later target is not what git reads now. */
  refsMoved?: boolean;
}

/** git subcommands that leave HEAD, every ref and config as they are. */
const KEEPS_REFS = new Set([
  'add',
  'annotate',
  'apply',
  'archive',
  'blame',
  'cat-file',
  'check-attr',
  'check-ignore',
  'checkout-index',
  'cherry',
  'clean',
  'count-objects',
  'describe',
  'diff',
  'diff-files',
  'diff-index',
  'diff-tree',
  'format-patch',
  'fsck',
  'gc',
  'grep',
  'hash-object',
  'help',
  'log',
  'ls-files',
  'ls-remote',
  'ls-tree',
  'merge-base',
  'mv',
  'name-rev',
  'range-diff',
  'read-tree',
  'restore',
  'rev-list',
  'rev-parse',
  'rm',
  'shortlog',
  'show',
  'show-branch',
  'show-ref',
  'sparse-checkout',
  'status',
  'update-index',
  'var',
  'version',
  'whatchanged',
  'write-tree',
]);

const LISTS_REFS =
  /^(-[arvln\d]+|--(list|all|remotes|verbose|show-current|no-color|no-column|ignore-case)|--(color|column|sort|merged|no-merged|contains|no-contains|points-at|format)=.*)$/;

/** Whether a git call may move HEAD, a ref, an upstream or config; `restores` when it only rewrites paths. */
function movesRefs(sub: string, args: readonly string[], restores: boolean): boolean {
  if (KEEPS_REFS.has(sub)) return false;
  const [first] = args;
  switch (sub) {
    case 'checkout':
    case 'switch':
      return !restores;
    case 'branch':
    case 'tag':
      return !args.every(arg => LISTS_REFS.test(arg));
    case 'stash':
      return first !== 'list' && first !== 'show';
    case 'config':
      return !args.some(arg => /^(--get(-all|-regexp|-urlmatch|-color|colorbool)?|--list|-l|get|list)$/.test(arg));
    case 'remote':
      return !(first === undefined || ['-v', '--verbose', 'show', 'get-url'].includes(first));
    case 'reflog':
      return !(first === undefined || first === 'show');
    case 'worktree':
      return first !== 'list';
    case 'fetch':
      return !args.includes('--dry-run');
    default:
      return true;
  }
}

/** What a git call that writes the work tree writes: `.claude` files and symlinks; unread when the scan cannot tell. */
interface TreeWrite {
  files: string[];
  links: boolean;
  unread: boolean;
}

const UNREAD_TREE: TreeWrite = { files: [], links: false, unread: true };
const NO_TREE: TreeWrite = { files: [], links: false, unread: false };

/** Whether a path git prints from the top of a work tree is under a `.claude` folder, in any case. */
const inSettings = (path: string): boolean => path.toLowerCase().split('/').includes('.claude');

/** Whether git in `directory` checks text out with CRLF and compares it as LF (`core.autocrlf` true or input). */
async function convertsCrlf(directory: string): Promise<boolean> {
  const value = await gitQuery(directory, ['config', '--get', 'core.autocrlf']);
  return value !== null && ['true', 'yes', 'on', '1', 'input'].includes(value.trim().toLowerCase());
}

/** Index entries the scan compares with the work tree itself before it reads the change as unknown. */
const COMPARED_ENTRIES = 256;

/**
 * Whether the file at `path` holds what the index records for it, by git's own blob hash of its raw bytes, or, when
 * `crlf` (`core.autocrlf` is true or input), of them with CRLF read as LF, as git itself compares them.
 */
async function sameAsIndex(path: string, mode: string, id: string, crlf: boolean): Promise<boolean> {
  const info = await lstat(path).catch(() => null);
  let content: Buffer | null = null;
  if (mode === '120000' && info?.isSymbolicLink()) {
    content = await readlink(path, { encoding: 'buffer' }).catch(() => null);
  } else if (mode !== '120000' && info?.isFile() && info.size <= MAX_PATCH_BYTES) {
    content = await readFile(path).catch(() => null);
  }
  if (content === null) return false;
  const blobId = (bytes: Buffer): string =>
    createHash(id.length === 64 ? 'sha256' : 'sha1')
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest('hex');
  if (blobId(content) === id) return true;
  if (!crlf || mode === '120000' || !content.includes('\r\n')) return false;
  return blobId(Buffer.from(content.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')) === id;
}

/**
 * The `.claude` files and links of the index (under `within`) whose work-tree copy differs from it, compared here
 * so git hashes no work-tree file; null when git fails or there are too many to compare.
 */
async function locallyChanged(
  top: string,
  within: readonly string[],
  from: string
): Promise<{ mode: string; path: string }[] | null> {
  const listed = await gitQuery(from, ['ls-files', '-s', '-z', '--full-name', '--', ...within]);
  if (listed === null) return null;
  const crlf = await convertsCrlf(from);
  const location = wslLocation(from);
  const changed: { mode: string; path: string }[] = [];
  let compared = 0;
  for (const entry of listed.split('\0')) {
    if (entry === '') continue;
    const [, mode, id, path] = /^(\d+) ([0-9a-f]+) \d\t(.*)$/s.exec(entry) ?? [];
    if (mode === undefined || id === undefined || path === undefined) return null;
    if (mode !== '120000' && !inSettings(path)) continue;
    if (++compared > COMPARED_ENTRIES) return null;
    const file = location ? wslUncPath(location, `${top}/${path}`) : `${top}/${path}`;
    if (!(await sameAsIndex(file, mode, id, crlf))) changed.push({ mode, path });
  }
  return changed;
}

/**
 * What changes in the work tree at `top` when it is made to match each target (null for the index): the `.claude`
 * files and the symlinks among the paths where the target differs from the index, and, when the command
 * `overwrites` local changes or a target is the index, those where the work tree differs from the index.
 */
async function treeDiff(
  top: string,
  targets: readonly (string | null)[],
  within: readonly string[] = [],
  from = top,
  overwrites = false
): Promise<TreeWrite> {
  const files = new Set<string>();
  let links = false;
  const note = (mode: string, path: string): void => {
    const symlink = mode === '120000';
    if (!symlink && !inSettings(path)) return;
    links ||= symlink;
    files.add(`${top}/${path}`);
  };
  for (const target of targets) {
    if (target === null) continue;
    if (!REVISION.test(target) || target.startsWith('-')) return UNREAD_TREE;
    // Run from `from` so pathspecs in `within` read as the command wrote them; git prints paths from the top.
    const raw = await gitQuery(from, [
      'diff-index',
      '--cached',
      '-R',
      '--raw',
      '-z',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      '--ignore-submodules=none',
      target,
      '--',
      ...within,
    ]);
    if (raw === null) return UNREAD_TREE;
    const fields = raw.split('\0');
    for (let at = 0; at + 1 < fields.length; at += 2) {
      const [, mode] = /^:\d+ (\d+) /.exec(fields[at] as string) ?? [];
      if (mode === undefined) return UNREAD_TREE;
      note(mode, fields[at + 1] as string);
    }
  }
  if (overwrites || targets.includes(null)) {
    const changed = await locallyChanged(top, within, from);
    if (changed === null) return UNREAD_TREE;
    for (const { mode, path } of changed) note(mode, path);
  }
  return { files: [...files], links, unread: false };
}

/**
 * What checking out `target` of the repository at `repository` into the new folder `destination` writes: the
 * `.claude` files and the symlinks of its whole tree, as a fresh checkout has nothing to compare against.
 */
async function treeListing(repository: string, target: string, destination: string): Promise<TreeWrite> {
  if (!REVISION.test(target) || target.startsWith('-')) return UNREAD_TREE;
  const raw = await gitQuery(repository, ['ls-tree', '-r', '-z', '--full-tree', target]);
  if (raw === null) return UNREAD_TREE;
  const files: string[] = [];
  let links = false;
  for (const entry of raw.split('\0')) {
    if (entry === '') continue;
    const [, mode, path] = /^(\d+) \w+ [0-9a-f]+\t(.*)$/s.exec(entry) ?? [];
    if (mode === undefined || path === undefined) return UNREAD_TREE;
    const symlink = mode === '120000';
    if (!symlink && !inSettings(path)) continue;
    links ||= symlink;
    files.push(`${destination}/${path}`);
  }
  return { files, links, unread: false };
}

/** Work-tree places, folders included, the scan lstats for a listing before it counts as one it cannot follow. */
const WORK_TREE_LOOKS = 50_000;

/**
 * The links in the work tree at `top` at or on the way to each of `paths` (given from the top), by an lstat of each
 * folder and entry, so a tracked path a link has replaced is seen; null past WORK_TREE_LOOKS or when one cannot be
 * looked at, or once `stopped`.
 */
async function workTreeLinks(top: string, paths: readonly string[], stopped: () => boolean): Promise<string[] | null> {
  const places = new Set<string>();
  for (const path of paths) {
    const parts = path.split('/');
    for (let end = 1; end <= parts.length; end++) places.add(parts.slice(0, end).join('/'));
    if (places.size > WORK_TREE_LOOKS) return null;
  }
  const ordered = [...places];
  const links: string[] = [];
  for (let at = 0; at < ordered.length; at += 256) {
    if (stopped()) return null;
    const batch = ordered.slice(at, at + 256);
    const linked = await Promise.all(
      batch.map(place =>
        lstat(`${top}/${place}`).then(
          info => info.isSymbolicLink(),
          (error: NodeJS.ErrnoException) => (error.code === 'ENOENT' || error.code === 'ENOTDIR' ? false : null)
        )
      )
    );
    for (const [index, link] of linked.entries()) {
      if (link === null) return null;
      if (link) links.push(`${top}/${batch[index]}`);
    }
  }
  return links;
}

/** One `ls-files -s -z` entry: its mode, blob id and path from the top. */
function indexEntries(listed: string): { mode: string; id: string; path: string }[] | null {
  const entries: { mode: string; id: string; path: string }[] = [];
  for (const entry of listed.split('\0')) {
    if (entry === '') continue;
    const [, mode, id, path] = /^(\d+) ([0-9a-f]+) \d\t(.*)$/s.exec(entry) ?? [];
    if (mode === undefined || id === undefined || path === undefined) return null;
    entries.push({ mode, id, path });
  }
  return entries;
}

export interface IndexListed {
  /** The settings files among the listed paths, absolute, each with whether its work-tree copy differs. */
  settings: { path: string; changed: boolean }[];
  /** Links at or on the way to a listed path in the work tree. */
  links: string[];
  /** Whether a listed path is one xargs may not pass whole (oddForXargs). */
  odd: boolean;
}

/**
 * What a listing of git's index under `pathspecs` from `from` (`git ls-files`, `git grep`) may print, read with no
 * git command that looks at the work tree; null when git fails, the index records a link there, or there is too
 * much to look at.
 */
export async function indexListed(
  from: string,
  pathspecs: readonly string[],
  stopped: () => boolean
): Promise<IndexListed | null> {
  const top = await gitToplevel(from);
  const listed =
    top === null ? null : await gitQuery(from, ['ls-files', '-s', '-z', '--full-name', '--', ...pathspecs]);
  const entries = listed === null ? null : indexEntries(listed);
  if (top === null || entries === null || entries.some(({ mode }) => mode === '120000')) return null;
  const crlf = await convertsCrlf(from);
  const settings: IndexListed['settings'] = [];
  for (const { mode, id, path } of entries) {
    if (!isSettingsPath(path)) continue;
    if (settings.length >= COMPARED_ENTRIES) return null;
    settings.push({ path: `${top}/${path}`, changed: !(await sameAsIndex(`${top}/${path}`, mode, id, crlf)) });
  }
  const paths = entries.map(({ path }) => path);
  const links = await workTreeLinks(top, paths, stopped);
  return links === null ? null : { settings, links, odd: paths.some(oddForXargs) };
}

/**
 * What `git diff --name-only [--cached] <words>` run at the top `top` compares, read as git reads the words: each a
 * revision (`A..B` its two ends, `A...B` whole) until one that is not a commit names a path, which with every later
 * word is a pathspec. Null when git would refuse them.
 */
export async function diffTargets(
  top: string,
  words: readonly string[],
  cached: boolean,
  stopped: () => boolean
): Promise<{ targets: string[]; worktree: boolean; pathspecs: string[] } | null> {
  const targets: string[] = [];
  let ends = 0;
  let at = 0;
  for (; at < words.length; at++) {
    const word = words[at] as string;
    if (word.includes('..')) {
      const range = word.includes('...') ? [word] : word.split('..').map(end => end || 'HEAD');
      if (word.split('...').length > 2 || range.length > 2) return null;
      targets.push(...range);
      ends += 2;
      if (ends > 2) return null;
      continue;
    }
    if (stopped()) return null;
    const commit =
      REVISION.test(word) &&
      !word.startsWith('-') &&
      (await gitQuery(top, ['rev-parse', '--verify', '--quiet', `${word}^{commit}`])) !== null;
    if (commit) {
      targets.push(word);
      ends++;
      if (ends > 2) return null;
      continue;
    }
    const exists = await lstat(resolve(top, word)).then(
      () => true,
      () => false
    );
    if (!exists) return null;
    break;
  }
  // Pathspec magic such as `attr:` would match against attributes git reads here with no GIT_ATTR_SOURCE.
  if (words.slice(at).some(word => word.startsWith(':'))) return null;
  return {
    targets: targets.length > 0 ? targets : cached ? ['HEAD'] : [],
    worktree: !cached && ends < 2,
    pathspecs: words.slice(at),
  };
}

/**
 * What `git diff --name-only` run at the top `top` may print when it compares each of `targets` and, when
 * `worktree`, the work tree: the settings files among those paths, and the links at or on the way to them. Read
 * with diff-index against the index and hashed here, so git runs no filter on the work tree; null when git fails or
 * there is too much to look at.
 */
export async function diffListed(
  top: string,
  targets: readonly string[],
  worktree: boolean,
  pathspecs: readonly string[],
  stopped: () => boolean
): Promise<{ settings: string[]; links: string[]; odd: boolean } | null> {
  const listed = await gitQuery(top, ['ls-files', '-s', '-z', '--full-name', '--', ...pathspecs]);
  const entries = listed === null ? null : indexEntries(listed);
  if (entries === null) return null;
  const printed = new Set<string>();
  const links = new Set<string>();
  const ends: string[] = [];
  for (const target of targets) {
    if (!target.includes('...')) {
      ends.push(target);
      continue;
    }
    // `A...B` compares B with the merge base of A and B.
    const [from = '', to = ''] = target.split('...').map(end => end || 'HEAD');
    if (![from, to].every(end => REVISION.test(end) && !end.startsWith('-'))) return null;
    const base = (await gitQuery(top, ['merge-base', from, to]))?.trim();
    if (base === undefined || !/^[0-9a-f]{40,64}$/.test(base)) return null;
    ends.push(base, to);
  }
  for (const target of ends) {
    if (!REVISION.test(target) || target.startsWith('-')) return null;
    const raw = await gitQuery(top, [
      'diff-index',
      '--cached',
      '--raw',
      '-z',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      '--ignore-submodules=none',
      target,
      '--',
      ...pathspecs,
    ]);
    if (raw === null) return null;
    const fields = raw.split('\0');
    for (let at = 0; at + 1 < fields.length; at += 2) {
      const [, from, to] = /^:(\d+) (\d+) /.exec(fields[at] as string) ?? [];
      if (from === undefined || to === undefined) return null;
      const path = fields[at + 1] as string;
      printed.add(path);
      if (from === '120000' || to === '120000') links.add(`${top}/${path}`);
      if (printed.size > WORK_TREE_LOOKS) return null;
    }
  }
  if (worktree) {
    const changed = await locallyChanged(top, pathspecs, top);
    if (changed === null) return null;
    for (const { mode, path } of changed) {
      printed.add(path);
      if (mode === '120000') links.add(`${top}/${path}`);
    }
  }
  const found = await workTreeLinks(top, [...entries.map(({ path }) => path), ...printed], stopped);
  if (found === null) return null;
  for (const link of found) links.add(link);
  return {
    settings: [...printed].filter(isSettingsPath).map(path => `${top}/${path}`),
    links: [...links],
    // The work tree may differ from the index at any entry, which only settings and links are compared for.
    odd: [...printed, ...(worktree ? entries.map(({ path }) => path) : [])].some(oddForXargs),
  };
}

const WORKTREE_ADD: GitGrammar = {
  letters: 'fdq',
  valued: 'bB',
  flags: [
    'force',
    'detach',
    'checkout',
    'no-checkout',
    'lock',
    'orphan',
    'quiet',
    'track',
    'no-track',
    'guess-remote',
    'no-guess-remote',
    'relative-paths',
    'no-relative-paths',
  ],
  long: ['reason'],
};

/** A clone source the scan can list: a folder on this machine, not a URL or `host:path`. */
async function localRepository(cwd: string, source: string): Promise<string | null> {
  if (/^[\w+.-]+:\/\//.test(source) || /^[^/\\]*:/.test(source.replace(/^[A-Za-z]:[\\/]/, ''))) return null;
  const path = resolveOperand(cwd, source);
  return (await stat(path).catch(() => null))?.isDirectory() ? path : null;
}

/**
 * The folder operand, as written, that a clone from another computer checks out into; null for a local source,
 * a clone that checks nothing out, or options the scan does not read.
 */
async function remoteCloneFolder(args: readonly string[], cwd: string): Promise<string | null> {
  const read = gitArgs(args, own(TREE_GRAMMARS, 'clone') ?? {});
  const [source, folder] = read.positionals;
  if (read.unknown || source === undefined || has(read, 'n', 'no-checkout', 'bare', 'mirror')) return null;
  if ((await localRepository(cwd, source)) !== null) return null;
  return folder ?? basename(source.replace(/[\\/:]+$/, '').replace(/^.*:/, '')).replace(/\.git$/, '');
}

/** Each listed path under a `.claude` folder, from the top of the work tree; null when git fails. */
async function settingsListed(top: string, args: readonly string[]): Promise<string[] | null> {
  const listed = await gitQuery(top, [...args, '-z', '--', ':(icase).claude', ':(icase)*/.claude/*']);
  return listed === null ? null : listed.split('\0').filter(path => path !== '' && inSettings(path));
}

/** What `git clean` would remove, from its own dry run with the same choice of files. */
async function cleanWrites(read: GitArgs, cwd: string): Promise<TreeWrite> {
  const options = ['d', 'x', 'X'].filter(letter => read.given.has(letter)).map(letter => `-${letter}`);
  const excludes = [read.given.get('e'), read.given.get('exclude')].filter(
    (value): value is string => typeof value === 'string'
  );
  const listed = await gitQuery(cwd, [
    'clean',
    '-n',
    ...options,
    ...excludes.map(pattern => `--exclude=${pattern}`),
    '--',
    ...read.positionals,
    ...read.paths,
  ]);
  if (listed === null) return UNREAD_TREE;
  const files: string[] = [];
  for (const line of listed.split('\n')) {
    const removed = /^Would remove (.+)$/.exec(line)?.[1];
    if (removed) files.push(resolveOperand(cwd, removed.replace(/\/$/, '')));
    else if (line.trim() !== '' && !line.startsWith('Would skip')) return UNREAD_TREE;
  }
  return { files, links: false, unread: false };
}

/**
 * What a git subcommand that rewrites the work tree from a commit writes, found by asking git what differs from
 * that commit; null for one that does not. A target git cannot resolve, an option outside TREE_GRAMMARS, or a
 * global option or GIT_* variable that can move the repository leaves it unread.
 */
async function gitTreeWrites(
  sub: string,
  args: readonly string[],
  cwd: string,
  script: GitScript,
  moved: boolean
): Promise<TreeWrite | null> {
  const grammar = own(TREE_GRAMMARS, sub);
  const read = gitArgs(args, grammar ?? {});
  const top = async (): Promise<string | null> => {
    const found = await gitToplevel(cwd);
    if (found === null) return null;
    // `core.worktree` can put the work tree elsewhere, which this folder is then not inside.
    const here = (await realpath(cwd).catch(() => null)) ?? '';
    const root = /^[A-Za-z]:\//.test(found) ? resolve(found) : found;
    return wslLocation(cwd) !== null || here === root || here.startsWith(root.endsWith(sep) ? root : root + sep)
      ? found
      : null;
  };
  const against = async (targets: readonly (string | null)[], overwrites = false): Promise<TreeWrite> => {
    if (moved || read.unknown) return UNREAD_TREE;
    const root = await top();
    return root === null ? UNREAD_TREE : treeDiff(root, targets, [], root, overwrites);
  };
  const previous = (target: string): string => (target === '-' ? '@{-1}' : target);
  switch (sub) {
    case 'checkout':
    case 'switch': {
      if (read.positionals.length === 0 && !has(read, 'b', 'B', 'c', 'C', 'create', 'force-create')) return NO_TREE;
      return against(
        [previous(read.positionals[0] ?? 'HEAD')],
        has(read, 'f', 'force', 'm', 'merge', 'discard-changes')
      );
    }
    case 'merge': {
      if (read.positionals.length === 0 && !(moved || read.unknown)) {
        const tracked = await upstreamTracked(cwd);
        if (tracked !== true) return tracked === null ? UNREAD_TREE : NO_TREE;
      }
      return against(read.positionals.length > 0 ? read.positionals : ['@{u}']);
    }
    case 'cherry-pick':
    case 'revert': {
      if (read.positionals.length === 0 || read.positionals.some(target => target.includes('..'))) return UNREAD_TREE;
      // A revert undoes a commit, so the tree it moves toward is the commit's parent.
      const parent = String(read.given.get('m') ?? read.given.get('mainline') ?? '');
      return against(sub === 'revert' ? read.positionals.map(target => `${target}^${parent}`) : read.positionals);
    }
    case 'reset': {
      const target = read.positionals[0] ?? 'HEAD';
      if (!has(read, 'hard', 'merge', 'keep')) {
        script.staged.push(target);
        return NO_TREE;
      }
      return read.positionals.length > 1 || read.paths.length > 0 ? UNREAD_TREE : against([target], true);
    }
    case 'read-tree': {
      if (has(read, 'u')) return against(has(read, 'empty') ? [EMPTY_TREE] : read.positionals, true);
      if (has(read, 'empty')) script.unknownIndex = true;
      script.staged.push(...read.positionals);
      return NO_TREE;
    }
    case 'checkout-index':
      if (has(read, 'temp')) return NO_TREE;
      return script.unknownIndex ? UNREAD_TREE : against([null, ...script.staged], true);
    case 'update-index':
      script.unknownIndex = true;
      return NO_TREE;
    case 'rebase': {
      const [upstream, branch] = read.positionals;
      const onto = read.given.get('onto');
      if (upstream === undefined && typeof onto !== 'string' && !(moved || read.unknown)) {
        const tracked = await upstreamTracked(cwd);
        if (tracked !== true) return tracked === null ? UNREAD_TREE : NO_TREE;
      }
      const base = typeof onto === 'string' ? onto : (upstream ?? '@{u}');
      return against(branch === undefined ? [base] : [base, branch]);
    }
    case 'stash': {
      const [action = 'push', ...rest] = read.positionals;
      if (['list', 'show', 'create', 'drop', 'clear', 'store'].includes(action)) return NO_TREE;
      if (action === 'apply' || action === 'pop') {
        const ref = rest[0] ?? 'stash@{0}';
        if (!REVISION.test(ref)) return UNREAD_TREE;
        // A stash holding untracked files writes them too, which the diff below does not list.
        const untracked = await gitRun(cwd, ['rev-parse', '--verify', '-q', `${ref}^3`]);
        if (untracked === null || untracked.code === 0) return UNREAD_TREE;
        return against([ref]);
      }
      if (action !== 'push' && action !== 'save') return UNREAD_TREE;
      const reverted = await against(['HEAD'], true);
      if (reverted.unread || !has(read, 'u', 'a', 'include-untracked', 'all')) return reverted;
      const root = await top();
      const untracked =
        root === null
          ? null
          : await settingsListed(root, ['ls-files', '-o', ...(has(read, 'a', 'all') ? [] : ['--exclude-standard'])]);
      if (untracked === null) return UNREAD_TREE;
      return { ...reverted, files: [...reverted.files, ...untracked.map(path => `${root}/${path}`)] };
    }
    case 'am': {
      if (moved || read.unknown || read.positionals.length === 0) return UNREAD_TREE;
      const root = await repositoryRoot(cwd);
      const mails = await Promise.all(read.positionals.map(path => readSmall(resolveOperand(cwd, path))));
      if (mails.some(mail => mail === null)) return UNREAD_TREE;
      const named = mails.flatMap(mail => patchedPaths(mail ?? ''));
      return { files: named.map(path => resolveOperand(root, path)), links: true, unread: false };
    }
    case 'clean':
      return moved || read.unknown ? UNREAD_TREE : cleanWrites(read, cwd);
    case 'worktree': {
      // `move` carries the tree's relative links to a new place, like mv.
      if (args[0] === 'move') return UNREAD_TREE;
      if (args[0] !== 'add') return null;
      const add = gitArgs(args.slice(1), WORKTREE_ADD);
      const [path, target] = add.positionals;
      if (moved || add.unknown || path === undefined || add.paths.length > 0) return UNREAD_TREE;
      if (has(add, 'no-checkout', 'orphan')) return NO_TREE;
      return treeListing(cwd, target ?? 'HEAD', resolveOperand(cwd, path));
    }
    case 'clone': {
      const [source, folder] = read.positionals;
      if (moved || read.unknown || source === undefined) return UNREAD_TREE;
      if (has(read, 'n', 'no-checkout', 'bare', 'mirror')) return NO_TREE;
      const repository = await localRepository(cwd, source);
      if (repository === null) return UNREAD_TREE;
      const name = folder ?? basename(repository.replace(/[\\/]+$/, '')).replace(/\.git$/, '');
      const branch = read.given.get('b') ?? read.given.get('branch');
      return treeListing(repository, typeof branch === 'string' ? branch : 'HEAD', resolveOperand(cwd, name));
    }
    case 'sparse-checkout': {
      if (['list', 'check-rules'].includes(args[0] ?? '')) return NO_TREE;
      const root = moved ? null : await top();
      const tracked = root === null ? null : await settingsListed(root, ['ls-files']);
      if (tracked === null) return UNREAD_TREE;
      return { files: tracked.map(path => `${root}/${path}`), links: false, unread: false };
    }
    case 'submodule': {
      const action = args.find(arg => !arg.startsWith('-'));
      if (action === 'status' || action === 'summary') return NO_TREE;
      if (action !== undefined && !['update', 'init', 'sync', 'deinit', 'absorbgitdirs'].includes(action)) {
        return UNREAD_TREE;
      }
      const staged = moved ? null : await gitQuery(cwd, ['ls-files', '-s', '-z']);
      if (staged === null) return UNREAD_TREE;
      return staged.split('\0').some(entry => entry.startsWith('160000 ')) ? UNREAD_TREE : NO_TREE;
    }
    case 'bisect':
      return ['log', 'view', 'visualize', 'terms', 'help'].includes(args[0] ?? '') ? NO_TREE : UNREAD_TREE;
    default:
      return null;
  }
}

/** `git apply` names paths from the top of the repository, so each is recorded there and from `cwd`. */
async function gitApplyWrites(args: readonly string[], node: Node, cwd: string): Promise<InPlaceWrites> {
  const reportOnly = args.some(arg => ['--check', '--stat', '--numstat', '--summary'].includes(arg));
  // `--cached` writes only the index, which a later checkout copies out, so its paths count as written too.
  if (reportOnly && !args.includes('--apply')) return { files: [], trees: [] };
  const prefix = optionValue(args, null, '--directory') ?? '';
  const root = await repositoryRoot(resolveOperand(cwd));
  const patches = operands(args, '');
  const diffs =
    patches.length > 0
      ? await Promise.all(patches.map(path => readSmall(resolveOperand(cwd, path))))
      : [await stdinText(node, cwd)];
  if (diffs.some(diff => diff === null)) return { files: [], trees: [root] };
  const named = diffs.flatMap(diff => patchedPaths(diff ?? ''));
  return {
    files: named.flatMap(path => [resolveOperand(root, prefix, path), resolveOperand(cwd, prefix, path)]),
    trees: named.length === 0 ? [root] : [],
  };
}

/**
 * Pathspecs `git checkout` or `git restore` rewrites, and the commit it takes them from (null for the index).
 */
function gitRestored(sub: string, args: readonly string[]): { paths: string[]; source: string | null } {
  const separator = args.indexOf('--');
  const valued = sub === 'restore' ? 's' : 'bB';
  const words = operands(
    args.filter((arg, index) => !['--source', '--orphan'].includes(args[index - 1] ?? '')),
    valued
  );
  const named = separator !== -1 ? args.slice(separator + 1) : words;
  if (sub === 'restore') {
    const source =
      optionValue(args, '-s', '--source') ?? (args.some(arg => /^(--staged|-[A-Za-z]*S)$/.test(arg)) ? 'HEAD' : null);
    return { paths: named, source };
  }
  // `git checkout <commit> <path>`: the first word names the commit, not a path.
  if (separator === -1) return { paths: named.slice(1), source: named[0] ?? null };
  return { paths: named, source: words.find(word => args.indexOf(word) < separator) ?? null };
}

/** git's global options that leave the repository and work tree where the folder puts them. */
const PLAIN_GIT_OPTIONS = new Set(['--no-pager', '-P', '-p', '--paginate', '--no-optional-locks']);

/**
 * `git [-C dir] [-c k=v] <sub> ...`: the subcommand, its arguments, the folder git runs in, and whether a global
 * option other than `-C` and the pager ones may point git at another repository or work tree.
 */
function gitSubcommand(
  args: readonly string[],
  cwd: string
): { sub: string; rest: string[]; cwd: string; moved: boolean } | null {
  let directory = cwd;
  let moved = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    if (arg === '-C') directory = resolveOperand(directory, args[++index] ?? '.');
    else if (!arg.startsWith('-')) return { sub: arg, rest: args.slice(index + 1), cwd: directory, moved };
    else if (!PLAIN_GIT_OPTIONS.has(arg)) {
      moved = true;
      if (['-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path'].includes(arg)) index++;
    }
  }
  return null;
}

/** What a scan carries from one git call to the next, and whether GIT_* variables may move the repository. */
export interface GitContext {
  script: GitScript;
  env: boolean;
  /** Granted folders, from which no program the scan runs is taken. */
  roots?: readonly string[];
}

/**
 * Files a command changes in place that a redirect or copy scan does not see: `sed -i` and its
 * perl, ruby and gawk kin, `patch` and `git apply`, archive extraction, decompression, and
 * `git checkout -- <path>` / `git restore`. `tokens` are unquoted, program first.
 */
export async function inPlaceWrites(
  tokens: readonly string[],
  node: Node,
  cwd: string,
  git: GitContext = { script: { staged: [], unknownIndex: false }, env: false }
): Promise<InPlaceWrites> {
  const { files, trees, links, unread, remote } = await writesOf(tokens, node, cwd, git);
  return {
    files: files.filter(path => !hasGlob(path)),
    trees: [...trees, ...files.filter(hasGlob).map(treeOf)],
    ...(links ? { links } : {}),
    ...(unread ? { unread } : {}),
    ...(remote !== undefined ? { remote } : {}),
  };
}

async function writesOf(
  tokens: readonly string[],
  node: Node,
  cwd: string,
  context: GitContext
): Promise<InPlaceWrites> {
  const [executable, ...args] = tokens;
  const program = basename(executable ?? '');
  const none: InPlaceWrites = { files: [], trees: [] };
  const extracted = (trees: string[] | null): InPlaceWrites =>
    trees === null ? { files: [], trees: [], unread: true } : { files: [], trees, links: true };
  if (program === 'patch') return { ...(await patchWrites(args, node, cwd)), links: true };
  if (program === 'tar' || program === 'bsdtar' || program === 'unzip') {
    const trees = program === 'unzip' ? unzipTrees(args) : tarTrees(args);
    const into = trees?.length === 1 ? (trees[0] as string) : null;
    // A clean listing is read member by member, so unpacking beside a session's settings is not a whole-tree write.
    if (into !== null && into !== '/' && (await lstat(resolveOperand(cwd, into, '.claude')).catch(() => null))) {
      const files = await extractedMembers(program, args, cwd, context.roots ?? []);
      if (files !== null) return { files, trees: [] };
    }
    return extracted(trees);
  }
  // 7-Zip takes its command as the first word that is not a switch, and its switches anywhere.
  const sevenZip = args.find(arg => !arg.startsWith('-'))?.toLowerCase();
  if (/^7zz?a?$/.test(program) && (sevenZip === 'x' || sevenZip === 'e')) {
    if (args.some(arg => /^-spf/i.test(arg))) return extracted(['/']);
    const output = args.find(arg => /^-o/i.test(arg))?.slice(2);
    return extracted([output || '.']);
  }
  if (program === 'cpio' && args.some(arg => shortCluster(arg).includes('i') || arg === '--extract')) {
    // cpio keeps an absolute member name unless told not to.
    if (!args.includes('--no-absolute-filenames')) return extracted(['/']);
    return extracted([optionValue(args, '-D', '--directory') ?? '.']);
  }
  if (own(DECOMPRESSORS, program)) return { files: decompressed(program, args), trees: [] };
  if (program === 'git') {
    const git = gitSubcommand(args, cwd);
    if (!git) return none;
    const script = context.script;
    const moved = git.moved || context.env || script.refsMoved === true;
    const { writes, restores } = await gitWrites(git, node, moved, script);
    script.refsMoved ||= movesRefs(git.sub, git.rest, restores);
    return writes;
  }
  return { files: inPlaceEdit(program, args), trees: [] };
}

/** What one git call writes, and whether it only rewrote paths (`git checkout -- <path>`), leaving HEAD where it was. */
async function gitWrites(
  git: { sub: string; rest: string[]; cwd: string },
  node: Node,
  moved: boolean,
  script: GitScript
): Promise<{ writes: InPlaceWrites; restores: boolean }> {
  const relocate = (path: string): string => resolveOperand(git.cwd, path);
  if (git.sub === 'apply') {
    return { writes: { ...(await gitApplyWrites(git.rest, node, git.cwd)), links: true }, restores: true };
  }
  if (git.sub === 'clone' && !moved) {
    const folder = await remoteCloneFolder(git.rest, git.cwd);
    if (folder !== null) return { writes: { files: [], trees: [], remote: folder }, restores: false };
  }
  let restored = git.sub === 'checkout' || git.sub === 'restore' ? gitRestored(git.sub, git.rest) : null;
  if (git.sub === 'checkout' && restored?.source && !git.rest.includes('--') && !moved) {
    // As git does: a first word that names no commit but an existing file is a path to restore from the index.
    const commit = await gitRun(git.cwd, ['rev-parse', '--verify', '-q', `${restored.source}^{commit}`]);
    const file = await lstat(resolveOperand(git.cwd, restored.source)).catch(() => null);
    if (commit !== null && commit.code !== 0 && file !== null && REVISION.test(restored.source)) {
      restored = { paths: [restored.source, ...restored.paths], source: null };
    }
  }
  if (restored && restored.paths.length > 0) {
    const { source, paths } = restored;
    if (git.sub === 'restore' && source !== null) script.staged.push(source);
    // From the index, a path takes whatever an earlier reset or read-tree staged there.
    const targets = source === null ? [null, ...script.staged] : [source];
    const root = moved || (source === null && script.unknownIndex) ? null : await gitToplevel(git.cwd);
    const diff = root === null ? UNREAD_TREE : await treeDiff(root, targets, paths, git.cwd, true);
    const writes = { files: diff.files, trees: paths.map(treeOf).map(relocate), links: true, unread: diff.unread };
    return { writes, restores: true };
  }
  const tree = await gitTreeWrites(git.sub, git.rest, git.cwd, script, moved);
  if (tree === null) return { writes: { files: [], trees: [] }, restores: false };
  const writes: InPlaceWrites = {
    files: tree.files,
    trees: [],
    ...(tree.links ? { links: true } : {}),
    ...(tree.unread ? { unread: true } : {}),
  };
  return { writes, restores: false };
}

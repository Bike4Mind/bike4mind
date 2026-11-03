import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { Node } from 'web-tree-sitter';

/**
 * Paths a command rewrites in place: `files` are single files, `trees` are folders whose
 * contents may all have changed. Relative paths resolve against the command's folder.
 */
export interface InPlaceWrites {
  files: string[];
  trees: string[];
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

/** GNU and BSD tar, including the old `tar xzf a.tgz` form whose letters take values in order. */
function tarTrees(args: readonly string[]): string[] {
  const rest = [...args];
  let extract = false;
  let directory: string | undefined;
  const members: string[] = [];
  const takeShort = (letters: string, attached: boolean): void => {
    for (let index = 0; index < letters.length; index++) {
      const letter = letters[index];
      if (letter === 'x') extract = true;
      if (!TAR_VALUED.includes(letter)) continue;
      const tail = letters.slice(index + 1);
      const value = attached && tail ? tail : rest.shift();
      if (letter === 'C') directory = value;
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
      const [name, value] = arg.slice(2).split(/=(.*)/s);
      if (name === 'extract' || name === 'get') extract = true;
      if (name === 'directory') directory = value ?? rest.shift();
      else if (value === undefined && ['file', 'files-from', 'exclude-from', 'blocking-factor'].includes(name)) {
        rest.shift();
      }
    } else if (arg.length > 1 && arg.startsWith('-')) {
      takeShort(arg.slice(1), true);
    } else {
      members.push(arg);
    }
  }
  if (!extract) return [];
  const base = directory ?? '.';
  return members.length > 0 ? members.map(member => join(base, treeOf(member))) : [base];
}

function unzipTrees(args: readonly string[]): string[] {
  if (args.some(arg => /[lptcZz]/.test(shortCluster(arg).replace(/d.*$/, '')))) return [];
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
  return members.length > 0 ? members.map(member => join(base, treeOf(member))) : [base];
}

function decompressed(program: string, args: readonly string[]): string[] {
  const shorts = args.map(shortCluster).join('');
  const decompress =
    DECOMPRESSORS[program].always ||
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
      if (target) return readSmall(resolve(cwd, target.replace(/^(['"])(.*)\1$/, '$2')));
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
  const diff = source ? await readSmall(resolve(cwd, directory, source)) : await stdinText(node, cwd);
  const named = diff ? patchedPaths(diff) : [];
  return {
    files: [...files, ...named].map(path => resolve(cwd, directory, path)),
    trees: named.length === 0 && files.length === 0 ? [directory] : [],
  };
}

/** The folder holding `.git` at or above `directory`, else `directory` itself. */
export async function repositoryRoot(directory: string): Promise<string> {
  for (let current = directory; ; current = dirname(current)) {
    if (await stat(join(current, '.git')).catch(() => null)) return current;
    if (dirname(current) === current) return directory;
  }
}

/** `git apply` names paths from the top of the repository, so each is recorded there and from `cwd`. */
async function gitApplyWrites(args: readonly string[], node: Node, cwd: string): Promise<InPlaceWrites> {
  const reportOnly = args.some(arg => ['--check', '--stat', '--numstat', '--summary'].includes(arg));
  if ((reportOnly && !args.includes('--apply')) || args.includes('--cached')) return { files: [], trees: [] };
  const prefix = optionValue(args, null, '--directory') ?? '';
  const root = await repositoryRoot(resolve(cwd));
  const patches = operands(args, '');
  const diffs =
    patches.length > 0
      ? await Promise.all(patches.map(path => readSmall(resolve(cwd, path))))
      : [await stdinText(node, cwd)];
  if (diffs.some(diff => diff === null)) return { files: [], trees: [root] };
  const named = diffs.flatMap(diff => patchedPaths(diff ?? ''));
  return {
    files: named.flatMap(path => [resolve(root, prefix, path), resolve(cwd, prefix, path)]),
    trees: named.length === 0 ? [root] : [],
  };
}

/** Pathspecs `git checkout` or `git restore` rewrites from the index or another commit. */
function gitRestoreTrees(sub: string, args: readonly string[]): string[] {
  const separator = args.indexOf('--');
  const valued = sub === 'restore' ? 's' : 'bB';
  const named =
    separator !== -1
      ? args.slice(separator + 1)
      : operands(
          args.filter((arg, index) => !['--source', '--orphan'].includes(args[index - 1] ?? '')),
          valued
        );
  // `git checkout <commit> <path>`: the first word names the commit, not a path.
  const paths = sub === 'checkout' && separator === -1 ? named.slice(1) : named;
  return paths.map(treeOf);
}

/** `git [-C dir] [-c k=v] <sub> ...`: the subcommand, its arguments and the folder git runs in. */
function gitSubcommand(args: readonly string[], cwd: string): { sub: string; rest: string[]; cwd: string } | null {
  let directory = cwd;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '-C') directory = resolve(directory, args[++index] ?? '.');
    else if (['-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(arg)) index++;
    else if (!arg.startsWith('-')) return { sub: arg, rest: args.slice(index + 1), cwd: directory };
  }
  return null;
}

/**
 * Files a command changes in place that a redirect or copy scan does not see: `sed -i` and its
 * perl, ruby and gawk kin, `patch` and `git apply`, archive extraction, decompression, and
 * `git checkout -- <path>` / `git restore`. `tokens` are unquoted, program first.
 */
export async function inPlaceWrites(tokens: readonly string[], node: Node, cwd: string): Promise<InPlaceWrites> {
  const { files, trees } = await writesOf(tokens, node, cwd);
  return {
    files: files.filter(path => !hasGlob(path)),
    trees: [...trees, ...files.filter(hasGlob).map(treeOf)],
  };
}

async function writesOf(tokens: readonly string[], node: Node, cwd: string): Promise<InPlaceWrites> {
  const [executable, ...args] = tokens;
  const program = basename(executable ?? '');
  const none: InPlaceWrites = { files: [], trees: [] };
  if (program === 'patch') return patchWrites(args, node, cwd);
  if (program === 'tar' || program === 'bsdtar') return { files: [], trees: tarTrees(args) };
  if (program === 'unzip') return { files: [], trees: unzipTrees(args) };
  if (/^7zz?a?$/.test(program) && (args[0] === 'x' || args[0] === 'e')) {
    const output = args.find(arg => arg.startsWith('-o'))?.slice(2);
    return { files: [], trees: [output || '.'] };
  }
  if (program === 'cpio' && args.some(arg => shortCluster(arg).includes('i') || arg === '--extract')) {
    return { files: [], trees: [optionValue(args, '-D', '--directory') ?? '.'] };
  }
  if (DECOMPRESSORS[program]) return { files: decompressed(program, args), trees: [] };
  if (program === 'git') {
    const git = gitSubcommand(args, cwd);
    if (!git) return none;
    const relocate = (path: string): string => resolve(git.cwd, path);
    if (git.sub === 'apply') return gitApplyWrites(git.rest, node, git.cwd);
    if (git.sub === 'checkout' || git.sub === 'restore') {
      return { files: [], trees: gitRestoreTrees(git.sub, git.rest).map(relocate) };
    }
    return none;
  }
  return { files: inPlaceEdit(program, args), trees: [] };
}

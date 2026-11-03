import { stat } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import type { Node } from 'web-tree-sitter';
import { directoryOptionValues } from './bashArity';
import { parseBash } from './bashParser';
import { isWithin, physicalTarget } from './paths';
import { expandHome, unquote, words } from './shellScan';
import { repositoryRoot } from './shellWrites';
import type { ToolContext } from './types';

const MAX_FILES_PER_SESSION = 200;
const MAX_SESSIONS = 50;
const MAX_PENDING = 100;

interface SessionWrites {
  /** Physical path -> a number that changes on every write. */
  files: Map<string, number>;
  /** Folders whose contents a command may have rewritten (an archive extracted, `git checkout -- dir`), the same way. */
  trees: Map<string, number>;
  /** Repositories whose `.git` or `.husky` folder was written, so git there can run new hooks. */
  hooks: Map<string, number>;
  /** Some writes were forgotten, so any script run asks. */
  overflowed: boolean;
}

/** A session's writes as kept on disk. */
export interface StoredSessionWrites {
  files: [string, number][];
  trees: [string, number][];
  hooks: [string, number][];
  overflowed: boolean;
}

/** Where each session's writes are kept, so a resumed session still asks. See SessionStore. */
export interface SessionWritesStore {
  loadSessionWrites(sessionId: string): Promise<unknown>;
  saveSessionWrites(sessionId: string, writes: StoredSessionWrites): Promise<void>;
  deleteSessionWrites(sessionId: string): Promise<void>;
}

/**
 * Files each session wrote, through the write tools or a shell command. Auto mode asks before a
 * command runs one of them (see shellTools' shellApproval), so a script is never written and run
 * unseen. Forgotten when the session is deleted (ChatService), kept across archive and, once a
 * store is set, across restarts.
 */
const bySession = new Map<string, SessionWrites>();
const evicted = new Set<string>();
/** Shell prompts that would run git over written hooks, by prompt key, cleared once one runs. */
const pendingHooks = new Map<string, { sessionId: string; hooks: [string, number][] }>();
// From the clock, so a generation kept on disk by an earlier run never recurs and revives an "always".
let writes = Date.now();
let store: SessionWritesStore | null = null;
/** Each session's disk reads and writes, in order. */
const queues = new Map<string, Promise<unknown>>();
const loading = new Map<string, Promise<SessionWrites | null>>();

export function keepSessionWritesIn(target: SessionWritesStore | null): void {
  store = target;
}

function enqueue<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
  const result = (queues.get(sessionId) ?? Promise.resolve()).then(work);
  const tail = result.catch(() => undefined);
  queues.set(sessionId, tail);
  void tail.then(() => {
    if (queues.get(sessionId) === tail) queues.delete(sessionId);
  });
  return result;
}

function entries(value: unknown): [string, number][] | null {
  if (!Array.isArray(value)) return null;
  const valid = value.every(entry => Array.isArray(entry) && typeof entry[0] === 'string' && Number.isFinite(entry[1]));
  return valid ? (value as [string, number][]) : null;
}

/** A stored record that does not read back cleanly counts as overflowed, so every script run asks. */
function fromStored(value: unknown): SessionWrites | null {
  if (value === null || value === undefined) return null;
  const stored = (typeof value === 'object' ? value : {}) as Partial<Record<keyof StoredSessionWrites, unknown>>;
  const files = entries(stored.files);
  const trees = entries(stored.trees ?? []);
  const hooks = entries(stored.hooks);
  const record: SessionWrites = {
    files: new Map(files ?? []),
    trees: new Map(trees ?? []),
    hooks: new Map(hooks ?? []),
    overflowed: stored.overflowed === true || !files || !trees || !hooks,
  };
  for (const map of [record.files, record.trees, record.hooks])
    for (const value of map.values()) writes = Math.max(writes, value);
  return record;
}

function remember(sessionId: string, record: SessionWrites): SessionWrites {
  bySession.delete(sessionId);
  bySession.set(sessionId, record);
  if (bySession.size > MAX_SESSIONS) {
    const oldest = bySession.keys().next().value as string;
    bySession.delete(oldest);
    // With a store the record is read back on next use; without one it is gone.
    if (!store) evicted.add(oldest);
  }
  return record;
}

/** The session's record, read from the store when it is not in memory. Undefined when it wrote nothing. */
async function sessionRecord(sessionId: string): Promise<SessionWrites | undefined> {
  const cached = bySession.get(sessionId);
  if (cached || !store) return cached;
  const from = store;
  let pending = loading.get(sessionId);
  if (!pending) {
    pending = enqueue(sessionId, async () => {
      try {
        return fromStored(await from.loadSessionWrites(sessionId));
      } catch {
        return { files: new Map(), trees: new Map(), hooks: new Map(), overflowed: true };
      }
    }).finally(() => loading.delete(sessionId));
    loading.set(sessionId, pending);
  }
  const loaded = await pending;
  return bySession.get(sessionId) ?? (loaded ? remember(sessionId, loaded) : undefined);
}

function save(sessionId: string, record: SessionWrites): Promise<void> {
  const to = store;
  if (!to) return Promise.resolve();
  return enqueue(sessionId, () =>
    to.saveSessionWrites(sessionId, {
      files: [...record.files],
      trees: [...record.trees],
      hooks: [...record.hooks],
      overflowed: record.overflowed,
    })
  ).catch(() => undefined);
}

async function recordWrite(context: ToolContext, target: string, kind: 'files' | 'trees'): Promise<void> {
  const id = context.sessionId;
  if (!id) return;
  const physical = await physicalTarget(target).catch(() => resolve(target));
  const record = remember(
    id,
    (await sessionRecord(id)) ?? {
      files: new Map(),
      trees: new Map(),
      hooks: new Map(),
      overflowed: evicted.has(id),
    }
  );
  const generation = ++writes;
  const paths = record[kind];
  paths.delete(physical);
  paths.set(physical, generation);
  if (paths.size > MAX_FILES_PER_SESSION) {
    paths.delete(paths.keys().next().value as string);
    record.overflowed = true;
  }
  const repository = /^(.*?)[\\/]\.(git|husky)([\\/]|$)/.exec(physical)?.[1];
  // `git config` from a subfolder is recorded as `<subfolder>/.git/config`; git means the enclosing repository.
  if (repository !== undefined) record.hooks.set((await repositoryRoot(repository)) || '/', generation);
  // The user's own git config applies in every repository.
  if (/[\\/](\.gitconfig|\.config[\\/]git[\\/]config)$/.test(physical)) record.hooks.set('/', generation);
  // An archive extracted over a repository can bring its own `.git/hooks`.
  if (kind === 'trees' && (await stat(join(physical, '.git')).catch(() => null)))
    record.hooks.set(physical, generation);
  await save(id, record);
}

export function recordSessionWrite(context: ToolContext, target: string): Promise<void> {
  return recordWrite(context, target, 'files');
}

/** A folder whose contents a command may have rewritten, so any file under it counts as written. */
export function recordSessionTreeWrite(context: ToolContext, target: string): Promise<void> {
  return recordWrite(context, target, 'trees');
}

export async function forgetSessionWrites(sessionId: string): Promise<void> {
  bySession.delete(sessionId);
  evicted.delete(sessionId);
  for (const [key, pending] of pendingHooks) if (pending.sessionId === sessionId) pendingHooks.delete(key);
  const from = store;
  if (from) await enqueue(sessionId, () => from.deleteSessionWrites(sessionId)).catch(() => undefined);
}

/** Called when an approved shell command starts: the hooks it was asked about count as seen. */
export function shellCommandRan(context: ToolContext): void {
  const pending = context.approvedKey ? pendingHooks.get(context.approvedKey) : undefined;
  if (!pending) return;
  pendingHooks.delete(context.approvedKey as string);
  const record = bySession.get(pending.sessionId);
  if (!record) return;
  for (const [repository, generation] of pending.hooks) {
    if (record.hooks.get(repository) === generation) record.hooks.delete(repository);
  }
  void save(pending.sessionId, record);
}

export function expectShellRun(key: string, sessionId: string, hooks: [string, number][]): void {
  if (hooks.length === 0) return;
  pendingHooks.delete(key);
  pendingHooks.set(key, { sessionId, hooks });
  if (pendingHooks.size > MAX_PENDING) pendingHooks.delete(pendingHooks.keys().next().value as string);
}

const WRAPPERS = new Set(['sudo', 'env', 'command', 'exec', 'nohup', 'time', 'nice', 'timeout', 'xargs']);
/** Leading words that start another program: `npx tsx x.ts` runs `tsx x.ts`. */
const LAUNCHERS: readonly (readonly string[])[] = [
  ['npx'],
  ['bunx'],
  ['pnpm', 'exec'],
  ['pnpm', 'dlx'],
  ['yarn', 'dlx'],
  ['uv', 'run'],
  ['poetry', 'run'],
];
const INTERPRETER =
  /^(sh|bash|zsh|dash|ksh|fish|source|\.|node|nodejs|bun|deno|tsx|ts-node|python[\d.]*|ruby|perl|php|lua|Rscript|pwsh|osascript|make)$/;
const SHELLS = /^(sh|bash|zsh|dash|ksh)$/;
const CONFIGURED_RUNNERS = new Set(['vitest', 'jest', 'pytest', 'py.test']);
const TEST_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'vitest', 'jest', 'pytest', 'py.test']);
const JS_CONFIG = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'];
const PACKAGE_FILES = ['package.json'];
const PYTEST_FILES = ['conftest.py', 'pytest.ini', 'pyproject.toml', 'setup.cfg'];
/** Programs that run code their config file in the working directory defines. */
const PROJECT_FILES: Record<string, readonly string[]> = {
  npm: PACKAGE_FILES,
  pnpm: PACKAGE_FILES,
  yarn: PACKAGE_FILES,
  bun: PACKAGE_FILES,
  make: ['Makefile', 'makefile', 'GNUmakefile'],
  vitest: JS_CONFIG.map(extension => `vitest.config.${extension}`),
  jest: [...JS_CONFIG, 'json'].map(extension => `jest.config.${extension}`),
  pytest: PYTEST_FILES,
  'py.test': PYTEST_FILES,
  uv: ['pyproject.toml'],
  poetry: ['pyproject.toml'],
  hatch: ['pyproject.toml'],
  cargo: ['build.rs'],
  just: ['justfile', 'Justfile', '.justfile'],
  task: ['Taskfile.yml', 'Taskfile.yaml'],
};

/** yarn's `--cwd`, which bashArity does not drop. */
function cwdOptionValues(args: readonly string[]): string[] {
  const values: string[] = [];
  for (const [index, arg] of args.entries()) {
    if (arg === '--cwd' && args[index + 1] !== undefined) values.push(args[index + 1]);
    else if (arg.startsWith('--cwd=')) values.push(arg.slice('--cwd='.length));
  }
  return values;
}

/** Values of `options` among the options before the first operand, as `-m mod` or `-mmod`. */
function leadingOptionValues(args: readonly string[], options: readonly string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length && args[index].startsWith('-'); index++) {
    const option = options.find(name => args[index].startsWith(name));
    if (!option) continue;
    const joined = args[index].slice(option.length);
    if (joined) values.push(joined);
    else if (args[index + 1] !== undefined) values.push(args[++index]);
  }
  return values;
}

/** Values of `options` anywhere in the arguments, as `--config x` or `--config=x`. */
function optionValues(args: readonly string[], options: readonly string[]): string[] {
  const values: string[] = [];
  for (const [index, arg] of args.entries()) {
    for (const option of options) {
      if (arg === option && args[index + 1] !== undefined) values.push(args[index + 1]);
      else if (arg.startsWith(`${option}=`)) values.push(arg.slice(option.length + 1));
    }
  }
  return values;
}

/** The paths a word can name: itself, or the value of `--opt=value`, split on spaces. */
function pathsIn(word: string): string[] {
  return unquote(word)
    .split(/\s+/)
    .flatMap(piece => {
      const equals = piece.indexOf('=');
      if (equals !== -1) return [piece.slice(equals + 1)];
      return piece.startsWith('-') ? [] : [piece];
    })
    .map(piece => piece.replace(/^['"]+|['"]+$/g, ''))
    .filter(Boolean);
}

function launcherLength(tokens: readonly string[], start: number): number {
  const match = LAUNCHERS.find(words => words.every((word, index) => tokens[start + index] === word));
  return match?.length ?? 0;
}

/** Where the program starts in `tokens` once leading wrappers and launchers (and their options) are skipped. */
function skipWrappers(tokens: readonly string[]): { start: number; wrapped: boolean; launched: boolean } {
  let start = 0;
  let wrapped = false;
  let launched = false;
  for (;;) {
    const launcher = launcherLength(tokens, start);
    if (launcher === 0 && !WRAPPERS.has(basename(tokens[start] ?? ''))) break;
    if (launcher === 0) wrapped = true;
    else launched = true;
    start += Math.max(launcher, 1);
    while (start < tokens.length && /^(-|\d|[A-Za-z_][A-Za-z0-9_]*=)/.test(tokens[start])) start++;
  }
  return { start, wrapped, launched };
}

/** A git config key that names a program git runs, set on the command line. */
const GIT_PROGRAM_KEY = /(^|\s)(-c\s*|--config-env[=\s])['"]?core\.(fsmonitor|hookspath|sshcommand)=?/i;

/** The `-c core.*` setting that makes git run a program, which auto mode asks about. */
export function gitRunsConfiguredProgram(commands: readonly { words: string }[]): string | null {
  for (const { words: text } of commands) {
    const match = /^\s*(\S+\s+)*?(\S*\/)?git\s/.test(text) ? GIT_PROGRAM_KEY.exec(text) : null;
    if (match) return `core.${match[3]}`;
  }
  return null;
}

export interface SessionScriptRun {
  /** The written files the command runs, as given on the command line. */
  names: string[];
  /** Repositories whose hooks or config this session wrote and the command runs git in. */
  hooks: [string, number][];
  /** True when some of the session's writes were forgotten, so the files may not be its own. */
  untracked: boolean;
  /** Changes whenever one of those files is written again, so a remembered answer can lapse with it. */
  generation: string;
}

/**
 * The files this session wrote that `command` would execute: as the program, as an operand or
 * input of an interpreter or launcher, or as the config a package manager or test runner reads.
 * Null when none.
 */
export async function sessionScriptRun(
  command: string,
  startDirectory: string,
  sessionId: string | undefined
): Promise<SessionScriptRun | null> {
  const found: FoundRuns = new Map();
  const hooks = new Map<string, number>();
  await scanScripts(command, startDirectory, sessionId, found, hooks);
  if (found.size === 0 && hooks.size === 0) return null;
  const runs = [...found.values()];
  return {
    names: [...new Set(runs.map(run => run.name))],
    hooks: [...hooks],
    untracked: runs.some(run => run.generation === '*'),
    generation: [...runs.map(run => run.generation), ...hooks.values()].join(','),
  };
}

type FoundRuns = Map<string, { name: string; generation: number | '*' }>;

/** Adds what `command` runs to `found` and `hooks`; a nested `sh -c` string adds to the same maps. */
async function scanScripts(
  command: string,
  startDirectory: string,
  sessionId: string | undefined,
  found: FoundRuns,
  hooks: Map<string, number>
): Promise<void> {
  const stored = sessionId ? await sessionRecord(sessionId) : undefined;
  const record = stored ?? (sessionId && evicted.has(sessionId) ? undefined : null);
  if (record === null) return;
  const written = record?.files ?? new Map<string, number>();
  const trees = record?.trees ?? new Map<string, number>();
  const overflowed = record?.overflowed ?? true;
  if (written.size === 0 && trees.size === 0 && !overflowed) return;
  const tree = await parseBash(command);
  // An unparsable command is already asked about by shellApproval.
  if (!tree) return;

  let cwd = startDirectory;

  const treeGeneration = async (physical: string): Promise<number | undefined> => {
    let newest: number | undefined;
    for (const [tree, generation] of trees) {
      if (isWithin(tree, physical) && generation > (newest ?? -Infinity)) newest = generation;
    }
    return newest !== undefined && (await stat(physical).catch(() => null))?.isFile() ? newest : undefined;
  };

  // Also resolved from the starting folder, since a `cd` inside a subshell is not undone here.
  const consider = async (raw: string, directory: string, exact = false): Promise<void> => {
    const text = expandHome(unquote(raw));
    if (!text || text.includes('$') || text.includes('`')) return;
    for (const base of new Set(exact ? [directory] : [directory, startDirectory])) {
      const physical = await physicalTarget(resolve(base, text)).catch(() => resolve(base, text));
      if (found.has(physical)) continue;
      const own = written.get(physical);
      const inTree = await treeGeneration(physical);
      const generation = own === undefined ? inTree : Math.max(own, inTree ?? own);
      if (generation !== undefined) found.set(physical, { name: text, generation });
      else if (overflowed && (await stat(physical).catch(() => null))?.isFile()) {
        found.set(physical, { name: text, generation: '*' });
      }
    }
  };

  const inputRedirects = (node: Node): string[] => {
    const parent = node.parent;
    if (parent?.type !== 'redirected_statement') return [];
    return parent.namedChildren
      .filter(child => child?.type === 'file_redirect' && child.text.trimStart().startsWith('<'))
      .map(child => child?.childForFieldName('destination')?.text ?? '');
  };

  const gitHooks = async (directories: string[]): Promise<void> => {
    for (const directory of directories) {
      const physical = await physicalTarget(directory).catch(() => directory);
      for (const [repository, generation] of record?.hooks ?? []) {
        if (isWithin(repository, physical)) hooks.set(repository, generation);
      }
    }
  };

  const visitCommand = async (node: Node, piped: boolean): Promise<void> => {
    const tokens = words(node).map(unquote);
    const { start, wrapped, launched } = skipWrappers(tokens);
    const [executable, ...args] = tokens.slice(start);
    if (executable === undefined) return;
    const program = basename(executable);
    if (!wrapped && (program === 'cd' || program === 'pushd')) {
      const target = args.find(arg => !arg.startsWith('-'));
      if (target && !target.includes('$')) cwd = resolve(cwd, expandHome(target));
      return;
    }
    if (program === 'git') {
      await gitHooks([cwd, ...directoryOptionValues(tokens.slice(start)).map(value => resolve(cwd, value))]);
      for (const value of leadingOptionValues(args, ['-c']))
        for (const path of pathsIn(value)) await consider(path, cwd);
    }
    if (executable.includes('/') || launched) await consider(executable, cwd);
    const module = /^python[\d.]*$/.test(program) ? leadingOptionValues(args, ['-m'])[0] : undefined;
    const runner = module ?? program;
    if (CONFIGURED_RUNNERS.has(runner) || args.some(arg => CONFIGURED_RUNNERS.has(arg))) {
      for (const value of optionValues(args, ['--config', '-c'])) await consider(value, cwd);
      for (const plugin of optionValues(args, ['-p'])) {
        for (const path of [plugin, `${plugin}.py`, `${plugin.replace(/\./g, '/')}.py`]) await consider(path, cwd);
      }
    }
    // A test runner's operands are test files, which edit-and-rerun loops change all the time.
    const runs = !TEST_RUNNERS.has(runner) && (wrapped || piped || INTERPRETER.test(program));
    // A launcher's own tool (`npx prettier src.ts`) only reads its operands; an interpreter runs them.
    const operands = wrapped ? tokens : args;
    if (runs) {
      // Behind a wrapper the program is not reliably the first word, so every word is a candidate.
      for (const word of operands) for (const path of pathsIn(word)) await consider(path, cwd);
      for (const target of inputRedirects(node)) await consider(target, cwd);
    }
    if (runs || PROJECT_FILES[program]) {
      for (const child of node.namedChildren) {
        if (child?.type !== 'variable_assignment') continue;
        for (const path of pathsIn(child.childForFieldName('value')?.text ?? '')) await consider(path, cwd);
      }
    }
    const inline = SHELLS.test(program) ? args.findIndex(arg => /^[-+][a-z]*c[a-z]*$/.test(arg)) : -1;
    if (inline !== -1 && args[inline + 1] !== undefined) {
      await scanScripts(args[inline + 1], cwd, sessionId, found, hooks);
    }
    const project = PROJECT_FILES[runner];
    if (project) {
      const named = [...directoryOptionValues(tokens.slice(start)), ...cwdOptionValues(args)];
      for (const directory of [cwd, ...named.map(value => resolve(cwd, value))]) {
        for (const file of project)
          await consider(relative(startDirectory, join(directory, file)), startDirectory, true);
      }
      // pytest also loads a conftest.py from any folder below the one it starts in.
      if (project === PYTEST_FILES) {
        const below = await physicalTarget(cwd).catch(() => cwd);
        for (const file of written.keys()) {
          if (basename(file) === 'conftest.py' && isWithin(below, file)) {
            await consider(relative(startDirectory, file), startDirectory, true);
          }
        }
      }
    }
    // `$(./x.sh)` and `<(cat x.sh)` run inside the command; a process substitution handed to an interpreter is its script.
    const interprets = wrapped || INTERPRETER.test(program);
    for (const substitution of node.descendantsOfType(['command_substitution', 'process_substitution'])) {
      for (const child of substitution?.namedChildren ?? []) {
        if (child) await visit(child, piped || (interprets && substitution?.type === 'process_substitution'));
      }
    }
  };

  const visit = async (node: Node, piped: boolean): Promise<void> => {
    if (node.type === 'command') return visitCommand(node, piped);
    // A file fed down a pipe into an interpreter runs as much as one named on its command line.
    const feedsInterpreter =
      node.type === 'pipeline' &&
      node.namedChildren.some(child => {
        if (child?.type !== 'command') return false;
        const tokens = words(child).map(unquote);
        return INTERPRETER.test(basename(tokens[skipWrappers(tokens).start] ?? ''));
      });
    for (const child of node.namedChildren) if (child) await visit(child, piped || feedsInterpreter);
  };

  try {
    await visit(tree.rootNode, false);
  } finally {
    tree.delete();
  }
}

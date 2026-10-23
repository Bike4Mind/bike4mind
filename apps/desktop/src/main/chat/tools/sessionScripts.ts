import { stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { Node } from 'web-tree-sitter';
import { directoryOptionValues } from './bashArity';
import { parseBash } from './bashParser';
import { isWithin, physicalTarget } from './paths';
import { unquote, words } from './shellScan';
import type { ToolContext } from './types';

const MAX_FILES_PER_SESSION = 200;
const MAX_SESSIONS = 50;
const MAX_PENDING = 100;

interface SessionWrites {
  /** Physical path -> a number that changes on every write. */
  files: Map<string, number>;
  /** Repositories whose `.git` or `.husky` folder was written, so git there can run new hooks. */
  hooks: Map<string, number>;
  /** Some writes were forgotten, so any script run asks. */
  overflowed: boolean;
}

/**
 * Files each session wrote, through the write tools or a shell command. Auto mode asks before a
 * command runs one of them (see shellTools' shellApproval), so a script is never written and run
 * unseen. Forgotten when the session closes (chat/index.ts).
 */
const bySession = new Map<string, SessionWrites>();
const evicted = new Set<string>();
/** Shell prompts that would run git over written hooks, by prompt key, cleared once one runs. */
const pendingHooks = new Map<string, { sessionId: string; hooks: [string, number][] }>();
let writes = 0;

export async function recordSessionWrite(context: ToolContext, target: string): Promise<void> {
  const id = context.sessionId;
  if (!id) return;
  const physical = await physicalTarget(target).catch(() => resolve(target));
  const record = bySession.get(id) ?? { files: new Map(), hooks: new Map(), overflowed: evicted.has(id) };
  const generation = ++writes;
  record.files.delete(physical);
  record.files.set(physical, generation);
  if (record.files.size > MAX_FILES_PER_SESSION) {
    record.files.delete(record.files.keys().next().value as string);
    record.overflowed = true;
  }
  const repository = /^(.*?)[\\/]\.(git|husky)([\\/]|$)/.exec(physical)?.[1];
  if (repository !== undefined) record.hooks.set((await repositoryRoot(repository)) || '/', generation);
  // The user's own git config applies in every repository.
  if (/[\\/](\.gitconfig|\.config[\\/]git[\\/]config)$/.test(physical)) record.hooks.set('/', generation);
  bySession.delete(id);
  bySession.set(id, record);
  if (bySession.size > MAX_SESSIONS) {
    const oldest = bySession.keys().next().value as string;
    bySession.delete(oldest);
    evicted.add(oldest);
  }
}

/** `git config` run from a subfolder is recorded as `<subfolder>/.git/config`; git means the enclosing repository. */
async function repositoryRoot(directory: string): Promise<string> {
  for (let current = directory; ; current = dirname(current)) {
    if (await stat(join(current, '.git')).catch(() => null)) return current;
    if (dirname(current) === current) return directory;
  }
}

export function forgetSessionWrites(sessionId: string): void {
  bySession.delete(sessionId);
  evicted.delete(sessionId);
  for (const [key, pending] of pendingHooks) if (pending.sessionId === sessionId) pendingHooks.delete(key);
}

/** Called when an approved shell command starts: the hooks it was asked about count as seen. */
export function shellCommandRan(context: ToolContext): void {
  const pending = context.approvedKey ? pendingHooks.get(context.approvedKey) : undefined;
  if (!pending) return;
  pendingHooks.delete(context.approvedKey as string);
  const record = bySession.get(pending.sessionId);
  for (const [repository, generation] of pending.hooks) {
    if (record?.hooks.get(repository) === generation) record.hooks.delete(repository);
  }
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
    .filter(Boolean);
}

function launcherLength(tokens: readonly string[], start: number): number {
  const match = LAUNCHERS.find(words => words.every((word, index) => tokens[start + index] === word));
  return match?.length ?? 0;
}

/** A git config key that names a program git runs, set on the command line. */
const GIT_PROGRAM_KEY = /(^|\s)(-c\s*|--config-env[=\s])['"]?core\.(fsmonitor|hookspath|sshcommand)=?/i;

/** The `-c core.*` setting that makes git run a program, which auto mode asks about. */
export function gitRunsConfiguredProgram(commands: readonly { words: string }[]): string | null {
  for (const { words: text } of commands) {
    const match = /^\s*(\S+\s+)*?git\s/.test(text) ? GIT_PROGRAM_KEY.exec(text) : null;
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
  const record = sessionId ? (bySession.get(sessionId) ?? (evicted.has(sessionId) ? undefined : null)) : null;
  if (record === null) return null;
  const written = record?.files ?? new Map<string, number>();
  const overflowed = record?.overflowed ?? true;
  if (written.size === 0 && !overflowed) return null;
  const tree = await parseBash(command);
  // An unparsable command is already asked about by shellApproval.
  if (!tree) return null;

  const found = new Map<string, { name: string; generation: number | '*' }>();
  const hooks = new Map<string, number>();
  let cwd = startDirectory;

  // Also resolved from the starting folder, since a `cd` inside a subshell is not undone here.
  const consider = async (raw: string, directory: string, exact = false): Promise<void> => {
    const text = unquote(raw);
    if (!text || text.includes('$') || text.includes('`')) return;
    for (const base of new Set(exact ? [directory] : [directory, startDirectory])) {
      const physical = await physicalTarget(resolve(base, text)).catch(() => resolve(base, text));
      if (found.has(physical)) continue;
      const generation = written.get(physical);
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
    const [executable, ...args] = tokens.slice(start);
    if (executable === undefined) return;
    const program = basename(executable);
    if (!wrapped && (program === 'cd' || program === 'pushd')) {
      const target = args.find(arg => !arg.startsWith('-'));
      if (target && !target.includes('$')) cwd = resolve(cwd, target);
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
    const inline = SHELLS.test(program) ? args.findIndex(arg => /^-[a-z]*c[a-z]*$/.test(arg)) : -1;
    if (inline !== -1 && args[inline + 1] !== undefined) {
      const nested = await sessionScriptRun(args[inline + 1], cwd, sessionId);
      if (nested) for (const name of nested.names) await consider(name, cwd);
      for (const [repository, generation] of nested?.hooks ?? []) hooks.set(repository, generation);
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
  };

  const visit = async (node: Node, piped: boolean): Promise<void> => {
    if (node.type === 'command') return visitCommand(node, piped);
    // A file fed down a pipe into an interpreter runs as much as one named on its command line.
    const feedsInterpreter =
      node.type === 'pipeline' &&
      node.namedChildren.some(child => {
        const name = child?.type === 'command' ? words(child)[0] : undefined;
        return name !== undefined && INTERPRETER.test(basename(unquote(name)));
      });
    for (const child of node.namedChildren) if (child) await visit(child, piped || feedsInterpreter);
  };

  try {
    await visit(tree.rootNode, false);
  } finally {
    tree.delete();
  }
  if (found.size === 0 && hooks.size === 0) return null;
  const runs = [...found.values()];
  return {
    names: [...new Set(runs.map(run => run.name))],
    hooks: [...hooks],
    untracked: runs.some(run => run.generation === '*'),
    generation: [...runs.map(run => run.generation), ...hooks.values()].join(','),
  };
}

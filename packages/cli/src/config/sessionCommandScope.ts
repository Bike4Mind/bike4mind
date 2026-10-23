import { parse as shellParse } from 'shell-quote';
import { classifyCommandRisk, INTERPRETERS, NETWORK_FETCHERS } from './commandRisk.js';

/**
 * Session approval scope for shell commands. An "allow for this session" answer on a shell tool
 * remembers each simple command's scope (`git status`, `ls`), and a later command runs unasked
 * only when every one of its simple commands has a remembered scope.
 *
 * Only commands on SESSION_SCOPE_ALLOW_LIST get a scope. Everything else, and anything with
 * substitutions, raw newlines, shell keywords, write redirects, network or interpreter programs,
 * or a high-risk classification, gets none and asks every time.
 */

const PACKAGE_SCRIPTS = new Set(['test', 'lint', 'typecheck', 'build', 'check', 'format:check']);

/** The only commands a session approval may cover. Program names match exactly. */
export const SESSION_SCOPE_ALLOW_LIST = {
  /** Read-only programs, scoped to the program alone. */
  readOnlyPrograms: new Set([
    'ls',
    'cat',
    'head',
    'tail',
    'wc',
    'pwd',
    'echo',
    'which',
    'file',
    'stat',
    'du',
    'df',
    'tree',
    'grep',
    'rg',
    'diff',
    'sort',
    'uniq',
    'cut',
    'date',
    'basename',
    'dirname',
    'realpath',
  ]),
  /** Test, build and lint runners, scoped to the program alone. */
  runnerPrograms: new Set(['tsc', 'vitest', 'jest', 'eslint', 'pytest']),
  gitReadOnly: new Set(['status', 'log', 'diff', 'show', 'blame', 'rev-parse', 'ls-files', 'describe', 'shortlog']),
  gitBranchListFlags: new Set(['-a', '-r', '-v', '-vv', '--list', '--show-current']),
  packageManagers: new Set(['npm', 'pnpm', 'yarn', 'bun']),
  /** Managers that run a script named directly (`pnpm lint`) as well as through `run`. */
  bareScriptManagers: new Set(['pnpm', 'yarn', 'bun']),
  packageTestCommands: new Set(['test', 't']),
  packageScripts: PACKAGE_SCRIPTS,
  subcommands: {
    go: new Set(['test', 'vet', 'build']),
    cargo: new Set(['test', 'check', 'build', 'clippy']),
  } as Readonly<Record<string, ReadonlySet<string>>>,
} as const;

/** Options that make an allow-listed command run a program or write a file: long prefixes and short letters. */
const REFUSED_OPTIONS: Readonly<Record<string, { long: readonly string[]; short?: string }>> = {
  git: { long: ['-c', '--config-env', '--exec-path', '--ext-diff', '--textconv', '--output'] },
  rg: { long: ['--pre'] },
  sort: { long: ['--output', '--compress-program'], short: 'o' },
  tree: { long: [], short: 'o' },
  go: { long: ['-exec', '-toolexec', '-vettool'] },
  cargo: { long: ['--config'] },
};

const PACKAGE_DIRECTORY_OPTIONS = ['--prefix', '--dir', '-C'];

/** Programs whose job is talking to another host. */
const NETWORK_PROGRAMS = new Set([
  ...NETWORK_FETCHERS,
  'nc',
  'ncat',
  'netcat',
  'socat',
  'telnet',
  'ssh',
  'scp',
  'sftp',
  'ftp',
  'rsync',
  'http',
  'https',
  'xh',
  'lwp-request',
  'gh',
  'aws',
  'gcloud',
  'gsutil',
  'az',
  's3cmd',
  'rclone',
]);

/** Shell keywords and grouping tokens: a compound command is never scoped. */
const RESERVED_WORDS = new Set([
  'if',
  'then',
  'elif',
  'else',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'select',
  'function',
  'in',
  'time',
  'coproc',
  '!',
  '{',
  '}',
  '[[',
  ']]',
]);

const SEPARATORS = new Set(['&&', '||', ';', '|', '|&', '&', '(', ')']);
const SAFE_PROGRAM_TOKEN = /^[a-z0-9_][a-z0-9_.+-]*$/;
const FD_TARGET = /^\d+$/;

type ShellToken = ReturnType<typeof shellParse>[number];

function programName(token: string): string {
  return token.slice(token.lastIndexOf('/') + 1).toLowerCase();
}

function isOperator(token: ShellToken): token is { op: string } {
  return typeof token === 'object' && token !== null && 'op' in token;
}

function wordOf(token: ShellToken | undefined): string | null {
  if (typeof token === 'string') return token;
  if (typeof token === 'object' && token !== null && 'pattern' in token) return (token as { pattern: string }).pattern;
  return null;
}

/**
 * Whether any word is one of these options. A single-dash option also matches with an attached
 * value (`-cfoo`); `short` is a letter that may sit in a bundle of short flags (`-uo`).
 */
function hasOption(words: readonly string[], long: readonly string[], short?: string): boolean {
  return words.some(word => {
    const named = long.some(
      option =>
        word === option || word.startsWith(`${option}=`) || (!option.startsWith('--') && word.startsWith(option))
    );
    return named || (short !== undefined && /^-[^-]/.test(word) && word.includes(short));
  });
}

function gitScope(args: readonly string[]): string | null {
  const list = SESSION_SCOPE_ALLOW_LIST;
  const [subcommand, ...rest] = args;
  if (list.gitReadOnly.has(subcommand)) return `git ${subcommand}`;
  if (subcommand === 'grep') return hasOption(rest, ['--open-files-in-pager'], 'O') ? null : 'git grep';
  if (subcommand === 'branch') return rest.every(word => list.gitBranchListFlags.has(word)) ? 'git branch' : null;
  if (subcommand === 'stash' && rest[0] === 'list') return 'git stash list';
  return null;
}

function packageScope(manager: string, args: readonly string[]): string | null {
  const list = SESSION_SCOPE_ALLOW_LIST;
  if (hasOption(args, PACKAGE_DIRECTORY_OPTIONS)) return null;
  const [subcommand, script] = args;
  if (list.packageTestCommands.has(subcommand)) return `${manager} ${subcommand}`;
  if (subcommand === 'run' && list.packageScripts.has(script)) return `${manager} run ${script}`;
  if (list.bareScriptManagers.has(manager) && list.packageScripts.has(subcommand)) return `${manager} ${subcommand}`;
  return null;
}

/** The scope a session approval of this simple command remembers, or null when it gets none. */
function segmentScope(words: string[]): string | null {
  const list = SESSION_SCOPE_ALLOW_LIST;
  const [program, ...args] = words;
  if (RESERVED_WORDS.has(program) || !SAFE_PROGRAM_TOKEN.test(program)) return null;
  // Any word naming a network or interpreter program also covers `xargs curl`, `pnpm exec sh`.
  const handsOff = words.some(word => {
    const candidate = programName(word);
    return NETWORK_PROGRAMS.has(candidate) || INTERPRETERS.has(candidate) || candidate === 'eval';
  });
  if (handsOff) return null;
  const refused = REFUSED_OPTIONS[program];
  if (refused && hasOption(args, refused.long, refused.short)) return null;

  if (list.readOnlyPrograms.has(program) || list.runnerPrograms.has(program)) {
    // `uniq IN OUT` writes OUT.
    if (program === 'uniq' && args.filter(word => !word.startsWith('-')).length > 1) return null;
    return program;
  }
  // A leading option could change what the subcommand means (`git -C`, `cargo --config`).
  if (args.length === 0 || args[0].startsWith('-')) return null;
  if (program === 'git') return gitScope(args);
  if (list.packageManagers.has(program)) return packageScope(program, args);
  return list.subcommands[program]?.has(args[0]) ? `${program} ${args[0]}` : null;
}

/** Redirects that only read a file, duplicate a descriptor, or discard output. */
function redirectIsHarmless(op: string, target: string | null): boolean {
  if (op === '<') return true;
  if (op === '>&') return target !== null && (FD_TARGET.test(target) || target === '-');
  if (op === '>' || op === '>>' || op === '&>' || op === '&>>') return target === '/dev/null';
  return false;
}

/**
 * The scopes a session approval of `command` would remember, one per simple command, or null
 * when the command must never be covered by a session approval.
 */
export function sessionCommandPrefixes(command: string): string[] | null {
  const text = command.replace(/\s+$/, '');
  if (text.length === 0) return null;
  if (/[\n\r`]/.test(text) || text.includes('$(') || text.includes('<(') || text.includes('>(')) return null;
  if (classifyCommandRisk(text).level === 'high') return null;

  let tokens: ShellToken[];
  try {
    // Keep `$VAR` literal so an expansion can never pose as a program name.
    tokens = shellParse(text, key => `$${key}`);
  } catch {
    return null;
  }

  const prefixes: string[] = [];
  let words: string[] = [];
  const flush = (): boolean => {
    if (words.length === 0) return true;
    const scope = segmentScope(words);
    if (scope === null) return false;
    prefixes.push(scope);
    words = [];
    return true;
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (isOperator(token)) {
      if (SEPARATORS.has(token.op)) {
        if (!flush()) return null;
        continue;
      }
      if (token.op === 'glob') {
        words.push((token as unknown as { pattern: string }).pattern);
        continue;
      }
      if (!redirectIsHarmless(token.op, wordOf(tokens[index + 1]))) return null;
      index += 1;
      continue;
    }
    const word = wordOf(token);
    if (word !== null) words.push(word);
  }
  if (!flush()) return null;
  return prefixes.length > 0 ? [...new Set(prefixes)] : null;
}

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

type OptionGrammar = {
  flags: string;
  values?: string;
  long?: readonly string[];
  longValues?: readonly string[];
  numeric?: boolean;
  maxOperands?: number;
};

// Exact, deliberately conservative grammars: an unknown option must ask again. These programs
// also expose mutating/executable options, so a blacklist cannot establish a read-only scope.
const READ_ONLY_OPTIONS: Readonly<Record<string, OptionGrammar>> = {
  ls: {
    flags: 'aAbBcCdDfFgGhHiklLmnopqQrRsStTuUvwxX1',
    long: ['all', 'almost-all', 'directory', 'human-readable', 'recursive', 'reverse'],
  },
  cat: {
    flags: 'benstuvAET',
    long: ['number', 'number-nonblank', 'squeeze-blank', 'show-all', 'show-ends', 'show-tabs'],
  },
  head: { flags: 'qv', values: 'nc', long: ['quiet', 'verbose'], longValues: ['lines', 'bytes'], numeric: true },
  tail: {
    flags: 'fqvF',
    values: 'nc',
    long: ['quiet', 'verbose', 'follow'],
    longValues: ['lines', 'bytes'],
    numeric: true,
  },
  wc: { flags: 'clLmw', long: ['bytes', 'chars', 'lines', 'words', 'max-line-length'] },
  pwd: { flags: 'LP' },
  echo: { flags: 'neE' },
  which: { flags: 'as' },
  file: { flags: 'bikLnNrs', values: 'Fm', long: ['brief', 'mime', 'mime-type', 'mime-encoding'] },
  stat: { flags: 'LfFltnx', values: 'c', long: ['dereference', 'terse'], longValues: ['format', 'printf'] },
  du: { flags: 'achHklLmsx', values: 'd', long: ['all', 'summarize', 'human-readable'], longValues: ['max-depth'] },
  df: { flags: 'ahiklPmT', long: ['all', 'human-readable', 'local', 'print-type'] },
  tree: { flags: 'adfFghilnpqrsuACD', values: 'LIP', long: ['dirsfirst', 'noreport', 'du', 'prune'] },
  grep: {
    flags: 'EFGivwxcLlnHhoqrsRUb',
    values: 'eAmBC',
    long: [
      'extended-regexp',
      'fixed-strings',
      'ignore-case',
      'invert-match',
      'word-regexp',
      'line-regexp',
      'count',
      'files-with-matches',
      'files-without-match',
      'line-number',
      'with-filename',
      'no-filename',
      'only-matching',
      'quiet',
      'recursive',
    ],
    longValues: ['regexp', 'after-context', 'before-context', 'context', 'max-count'],
  },
  rg: {
    flags: 'ivwxcLlnoqFsUuH',
    values: 'eAgBCTmt',
    long: [
      'files',
      'hidden',
      'no-ignore',
      'line-number',
      'ignore-case',
      'fixed-strings',
      'count',
      'files-with-matches',
      'files-without-match',
      'only-matching',
      'quiet',
      'heading',
      'no-heading',
      'stats',
      'multiline',
      'pcre2',
      'no-config',
    ],
    longValues: [
      'regexp',
      'glob',
      'iglob',
      'type',
      'type-not',
      'max-count',
      'after-context',
      'before-context',
      'context',
      'encoding',
    ],
  },
  diff: {
    flags: 'abBcdEiqrsStuUwNy',
    values: 'CI',
    long: ['brief', 'recursive', 'unified', 'ignore-all-space', 'ignore-space-change'],
    longValues: ['context'],
  },
  sort: {
    flags: 'bcdfghinMrsRsuVz',
    values: 'kt',
    long: ['unique', 'reverse', 'numeric-sort', 'human-numeric-sort', 'version-sort', 'ignore-case', 'stable'],
    longValues: ['key', 'field-separator'],
  },
  uniq: { flags: 'cdiuz', values: 'fsw', long: ['count', 'repeated', 'unique', 'ignore-case'], maxOperands: 1 },
  cut: {
    flags: 'nsz',
    values: 'bcdf',
    long: ['complement', 'only-delimited', 'zero-terminated'],
    longValues: ['bytes', 'characters', 'delimiter', 'fields', 'output-delimiter'],
  },
  date: { flags: 'uR', long: ['utc', 'universal', 'rfc-email', 'iso-8601'], maxOperands: 1 },
  basename: { flags: 'asz', values: 's', long: ['multiple', 'zero'], longValues: ['suffix'] },
  dirname: { flags: 'z', long: ['zero'] },
  realpath: {
    flags: 'eLmPqsz',
    long: ['canonicalize-existing', 'canonicalize-missing', 'logical', 'physical', 'quiet', 'strip', 'zero'],
  },
};

const GIT_OPTIONS: Readonly<Record<string, OptionGrammar>> = {
  status: {
    flags: 'sbz',
    values: 'u',
    long: ['short', 'branch', 'porcelain', 'ignored', 'show-stash'],
    longValues: ['untracked-files', 'ignore-submodules'],
  },
  log: {
    flags: 'pPuUz',
    values: 'n',
    numeric: true,
    long: [
      'oneline',
      'all',
      'branches',
      'tags',
      'remotes',
      'graph',
      'decorate',
      'no-decorate',
      'stat',
      'name-only',
      'name-status',
      'reverse',
      'no-merges',
      'merges',
      'first-parent',
      'follow',
      'no-patch',
    ],
    longValues: ['max-count', 'since', 'until', 'author', 'grep', 'format', 'pretty', 'date', 'skip'],
  },
  diff: {
    flags: 'pUuwbBz',
    values: 'U',
    long: [
      'stat',
      'numstat',
      'shortstat',
      'name-only',
      'name-status',
      'cached',
      'staged',
      'check',
      'no-index',
      'quiet',
      'exit-code',
      'no-ext-diff',
      'no-textconv',
      'ignore-all-space',
      'ignore-space-change',
    ],
  },
  show: {
    flags: 'psz',
    long: ['stat', 'name-only', 'name-status', 'oneline', 'no-patch', 'no-ext-diff', 'no-textconv'],
    longValues: ['format', 'pretty'],
  },
  blame: {
    flags: 'bcelnpswf',
    values: 'L',
    long: ['line-porcelain', 'porcelain', 'show-email', 'show-name', 'show-number'],
  },
  'rev-parse': {
    flags: '',
    long: [
      'show-toplevel',
      'show-prefix',
      'show-cdup',
      'git-dir',
      'absolute-git-dir',
      'is-inside-work-tree',
      'is-bare-repository',
      'verify',
      'short',
      'abbrev-ref',
      'symbolic-full-name',
    ],
  },
  'ls-files': {
    flags: 'cdimostuz',
    long: ['cached', 'deleted', 'modified', 'others', 'stage', 'unmerged', 'exclude-standard'],
  },
  describe: {
    flags: '',
    long: ['all', 'tags', 'always', 'long', 'exact-match'],
    longValues: ['match', 'exclude', 'abbrev', 'candidates'],
  },
  shortlog: { flags: 'nse', long: ['numbered', 'summary', 'email'] },
  grep: {
    flags: 'EFGivwxcLlnHhoqz',
    values: 'eABC',
    long: [
      'cached',
      'no-index',
      'untracked',
      'recurse-submodules',
      'line-number',
      'ignore-case',
      'fixed-strings',
      'count',
      'quiet',
    ],
    longValues: ['max-depth'],
  },
};

/** The only commands a session approval may cover. Program names match exactly. */
export const SESSION_SCOPE_ALLOW_LIST = {
  /** Read-only programs, scoped to the program alone. */
  readOnlyPrograms: new Set(Object.keys(READ_ONLY_OPTIONS)),
  /** Test, build and lint runners, scoped to the program alone. */
  runnerPrograms: new Set(['tsc', 'vitest', 'jest', 'eslint', 'pytest']),
  gitReadOnly: new Set(Object.keys(GIT_OPTIONS)),
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

function optionsAreReadOnly(args: readonly string[], grammar: OptionGrammar): boolean {
  let operands = 0;
  let optionsEnded = false;
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    if (word === '--' && !optionsEnded) {
      optionsEnded = true;
      continue;
    }
    if (optionsEnded || word === '-' || !word.startsWith('-')) {
      operands += 1;
      continue;
    }
    if (grammar.numeric && /^-\d+$/.test(word)) continue;
    if (word.startsWith('--')) {
      const equals = word.indexOf('=');
      const name = word.slice(2, equals < 0 ? undefined : equals);
      if (grammar.longValues?.includes(name)) {
        if (equals >= 0) continue;
        if (args[index + 1] === undefined || args[index + 1].startsWith('-')) return false;
        index += 1;
        continue;
      }
      if (equals >= 0 || !grammar.long?.includes(name)) return false;
      continue;
    }
    for (let letter = 1; letter < word.length; letter += 1) {
      if (grammar.values?.includes(word[letter])) {
        if (letter === word.length - 1) {
          if (args[index + 1] === undefined || args[index + 1].startsWith('-')) return false;
          index += 1;
        }
        break;
      }
      if (!grammar.flags.includes(word[letter])) return false;
    }
  }
  return grammar.maxOperands === undefined || operands <= grammar.maxOperands;
}

/** Options controlling how a deliberately approved build/script executes still need a fresh ask. */
const REFUSED_OPTIONS: Readonly<Record<string, { long: readonly string[]; short?: string }>> = {
  go: { long: ['-exec', '-toolexec', '-vettool'] },
  cargo: { long: ['--config'] },
};

const PACKAGE_EXECUTION_OPTIONS = [
  '--prefix',
  '--dir',
  '--cwd',
  '--directory',
  '--working-dir',
  '-C',
  '--script-shell',
  '--shell',
  '--shell-emulator',
  '--use-yarnrc',
  '--modules-folder',
];

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

/** Command tokens must never resolve inherited Object.prototype members as policy entries. */
function ownValue<Value>(record: Readonly<Record<string, Value>>, key: string): Value | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function gitScope(args: readonly string[]): string | null {
  const list = SESSION_SCOPE_ALLOW_LIST;
  const [subcommand, ...rest] = args;
  const grammar = ownValue(GIT_OPTIONS, subcommand);
  if (list.gitReadOnly.has(subcommand) && grammar)
    return optionsAreReadOnly(rest, grammar) ? `git ${subcommand}` : null;
  if (subcommand === 'branch') return rest.every(word => list.gitBranchListFlags.has(word)) ? 'git branch' : null;
  if (subcommand === 'stash' && rest[0] === 'list') {
    return optionsAreReadOnly(rest.slice(1), GIT_OPTIONS.log) ? 'git stash list' : null;
  }
  return null;
}

function packageScope(manager: string, args: readonly string[]): string | null {
  const list = SESSION_SCOPE_ALLOW_LIST;
  if (hasOption(args, PACKAGE_EXECUTION_OPTIONS)) return null;
  // Manager flags can select a different shell/project (including abbreviated npm flags).
  // Script/runner arguments remain intentional after the explicit forwarding separator.
  const forwardingSeparator = args.indexOf('--');
  const managerArgs = forwardingSeparator < 0 ? args : args.slice(0, forwardingSeparator);
  if (managerArgs.some(word => word.startsWith('-'))) return null;
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
  const refused = ownValue(REFUSED_OPTIONS, program);
  if (refused && hasOption(args, refused.long, refused.short)) return null;

  if (list.readOnlyPrograms.has(program)) {
    const grammar = ownValue(READ_ONLY_OPTIONS, program);
    if (!grammar || !optionsAreReadOnly(args, grammar)) return null;
    // BSD date accepts a positional clock-setting operand, even without -s.
    if (program === 'date' && args.some(word => !word.startsWith('-') && !word.startsWith('+'))) return null;
    return program;
  }
  if (list.runnerPrograms.has(program)) return program;
  // A leading option could change what the subcommand means (`git -C`, `cargo --config`).
  if (args.length === 0 || args[0].startsWith('-')) return null;
  if (program === 'git') return gitScope(args);
  if (list.packageManagers.has(program)) return packageScope(program, args);
  return ownValue(list.subcommands, program)?.has(args[0]) ? `${program} ${args[0]}` : null;
}

/** Redirects that only read a file, duplicate a descriptor, or discard output. */
function redirectIsHarmless(op: string, target: string | null): boolean {
  if (op === '<') return true;
  if (op === '>&') return target !== null && (FD_TARGET.test(target) || target === '-');
  if (op === '>' || op === '>>' || op === '&>' || op === '&>>') return target === '/dev/null';
  return false;
}

/** Reject expansions before parsing discards the quoting that determines their meaning. */
function hasShellExpansion(command: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === "'" && quote !== '"') {
      quote = quote === "'" ? null : "'";
      continue;
    }
    if (quote === "'") continue;
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '"') {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (character === '$' || character === '`') return true;
    if (quote === null && /[*?\[\]{}~]/.test(character)) return true;
  }
  return quote !== null;
}

/**
 * The scopes a session approval of `command` would remember, one per simple command, or null
 * when the command must never be covered by a session approval.
 */
export function sessionCommandPrefixes(command: string): string[] | null {
  const text = command.replace(/\s+$/, '');
  if (text.length === 0) return null;
  if (hasShellExpansion(text)) return null;
  if (/[\n\r`]/.test(text) || text.includes('$(') || text.includes('<(') || text.includes('>(')) return null;
  if (classifyCommandRisk(text).level === 'high') return null;

  let tokens: ShellToken[];
  try {
    // Expansions were rejected above; retain the callback as a fail-closed parsing guard.
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
        return null;
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

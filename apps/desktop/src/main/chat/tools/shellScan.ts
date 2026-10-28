import { stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';
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
import { ghReadFiles, repositoryWrite, type RepositoryWrite } from './ownRepository';
import { realpathNearest, resolveWithinRootsPhysically } from './paths';
import { inPlaceWrites } from './shellWrites';

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
  /** Directories the command reaches outside every granted root and the temp dirs. */
  directories: string[];
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
  /** Files the script writes by redirect, `tee`, a copy or download destination, or in place (see shellWrites). */
  writes: string[];
  /** Folders whose contents the script may rewrite, such as an archive's extraction folder. */
  writtenTrees: string[];
}

const CHANGES_DIRECTORY = new Set(['cd', 'chdir', 'pushd', 'popd']);
const COPIES = new Set(['cp', 'mv', 'install', 'ln', 'rsync', 'scp']);
// The short flag may close a cluster (`-fsSLo`, `-qO`); curl's `-O` names no path, so case matters.
const DOWNLOAD_OUTPUT: Record<string, { long: string; short: RegExp }> = {
  curl: { long: '--output', short: /^-[a-zA-Z]*?o(.*)$/ },
  wget: { long: '--output-document', short: /^-[a-zA-Z]*?O(.*)$/ },
};
const GIT_CONFIG_SETS =
  /^(set|unset|edit|-e|--edit|--add|--unset|--unset-all|--replace-all|--rename-section|--remove-section|rename-section|remove-section)$/;

/** Programs that only read what they are pointed at, when `containedCommand` also vouches for the call. */
const READ_PROBES = new Set(['ls', 'cat', 'head', 'tail', 'stat', 'file', 'wc', 'du', 'tree', 'find']);

/**
 * Where version managers and package managers install toolchains. An agent lists and reads these
 * to find which node or pnpm a project runs on; they hold binaries and package code, not secrets.
 * Deliberately narrow: `~/.local/share` as a whole also holds keyrings and app data.
 */
function toolchainLocations(): string[] {
  const home = homedir();
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
    ].map(path => join(home, path)),
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
}

// Credential files a package manager or a shell keeps beside its toolchain.
const SECRET_NAME = /^\.?(npmrc|netrc|pypirc|git-credentials|yarnrc(\.yml)?)$|credential|secret|token/i;

const namesSecret = (path: string): boolean => path.split('/').some(part => SECRET_NAME.test(part)) || isEnvFile(path);

/**
 * Whether a path outside the project is a toolchain install that a read-only probe may look at
 * unasked, both as written and with every symlink followed, so `~/.nvm/link -> ~/.ssh` still asks.
 */
export async function isToolchainPath(path: string, cwd: string): Promise<boolean> {
  if (namesSecret(resolve(cwd, path))) return false;
  try {
    // Each root is resolved the way the path is: a root that does not exist under a linked
    // parent (macOS `/etc` -> `/private/etc`) must still match the path's physical form.
    const roots = await Promise.all(
      toolchainLocations().map(root => resolveWithinRootsPhysically(root, [parse(root).root], root))
    );
    return !namesSecret(await resolveWithinRootsPhysically(path, roots, cwd));
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

/** `~` and `$HOME` are the user's home, which the shell expands before the program sees it. */
export function expandHome(text: string): string {
  const home = homedir();
  if (text === '~') return home;
  if (text.startsWith('~/')) return join(home, text.slice(2));
  const named = /^~([^/]+)(\/.*)?$/.exec(text);
  if (named) return join(dirname(home), named[1], named[2] ?? '');
  const variable = /^\$(?:HOME|\{HOME\})(\/.*)?$/.exec(text);
  if (variable) return join(home, variable[1] ?? '');
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

// ponytail: a wrapper's own option values (`sudo -u bob`, `xargs -I {}`) are read as the program;
// a full per-wrapper option table if that matters.
const WRAPPERS = new Set(['sudo', 'env', 'command', 'exec', 'nohup', 'time', 'nice', 'timeout', 'xargs']);

/** The command a wrapper (`sudo`, `env X=1`, `timeout 5`) runs, with the wrapper's own words dropped. */
function withoutWrappers(tokens: readonly string[]): string[] {
  let start = 0;
  while (start < tokens.length && WRAPPERS.has(basename(unquote(tokens[start])))) {
    start++;
    while (start < tokens.length && /^(-|\d)|=/.test(tokens[start])) start++;
  }
  return tokens.slice(start);
}

/** A wrapper can change the executable, and these clients can start sending data just by changing flags. */
export function requiresExactShellRule(command: string): boolean {
  const head = /^(?:"([^"]*)"|'([^']*)'|(\S+))(?:\s+|$)/.exec(command);
  if (!head) return true;
  const executable = head[1] ?? head[2] ?? head[3];
  const program = basename(executable);
  const argumentsText = command.slice(head[0].length);
  return (
    // Quoting or an absolute executable defeats arityPrefix's bare-program lookup.
    head[1] !== undefined ||
    head[2] !== undefined ||
    executable !== program ||
    WRAPPERS.has(program) ||
    /^(curl|wget|rsync|aws|gsutil|gcloud|docker|podman)$/.test(program) ||
    (program === 'gh' &&
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
const INLINE_SCRIPT: Record<string, RegExp> = {
  node: /^(-[a-zA-Z]*[ep]|--eval|--print)(=|$)/,
  ruby: /^-[a-zA-Z]*e/,
  perl: /^-[a-zA-Z]*[eE]/,
  php: /^-r/,
  bun: /^(-[a-zA-Z]*[ep]|--eval|--print)(=|$)/,
  osascript: /^-e/,
  sh: SHELL_C,
  bash: SHELL_C,
  zsh: SHELL_C,
  dash: SHELL_C,
};

/**
 * The option letters whose value is glued to the flag, so a letter after one is that value rather
 * than another flag: `ruby -rset` loads the library `set`, it does not run `-e`. Only list letters
 * the interpreter documents as taking a value.
 */
const OPTION_VALUE_LETTERS: Record<string, string> = {
  python: 'WX',
  node: 'rC',
  bun: 'rld',
  perl: 'IMmx',
  ruby: 'rICEKFx',
  osascript: 'ls',
  zsh: 'oO',
};

/**
 * Value letters that take only a glued value (`ruby -xdir`): even at the end of a cluster they do
 * not swallow the next word, so a script's own `-e` after `ruby -x script.rb` is not ruby's option.
 */
const GLUED_ONLY_LETTERS: Record<string, string> = {
  perl: 'x',
  ruby: 'xKF',
};

/** The long forms of the above whose value is the next argument rather than glued to the flag. */
const OPTION_VALUE_WORDS: Record<string, readonly string[]> = {
  node: ['--require', '--import'],
  bun: ['--require', '--preload'],
  bash: ['--rcfile', '--init-file'],
};

/** Common long options that take no value, so the word after one is not assumed to be its value. */
const OPTION_FLAG_WORDS: Record<string, readonly string[]> = {
  node: ['--inspect', '--inspect-brk', '--watch', '--enable-source-maps', '--no-warnings', '--trace-warnings'],
  bun: ['--watch', '--hot', '--smol'],
};

/** Shells where -o/-O (and +o/+O) name an option in the next word, leaving the rest of the cluster as flags. */
const SHELL_OPTION_WORD = new Set(['sh', 'bash', 'dash']);

function optionValueLetters(program: string): string {
  return /^python[\d.]*$/.test(program) ? OPTION_VALUE_LETTERS.python : (OPTION_VALUE_LETTERS[program] ?? '');
}

/** The value letters that take the next word when they end a cluster; glued-only letters do not. */
function nextWordLetters(program: string): string {
  const glued = GLUED_ONLY_LETTERS[program] ?? '';
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
  if (arg.startsWith('--')) return !arg.includes('=') && (OPTION_VALUE_WORDS[program] ?? []).includes(arg);
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
  const plusFlags = INLINE_SCRIPT[program] === SHELL_C;
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
      !(OPTION_FLAG_WORDS[program] ?? []).includes(arg) &&
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
  let start = 0;
  while (start < normalised.length && WRAPPERS.has(basename(normalised[start]))) {
    start++;
    while (start < normalised.length && /^(-|\d|[A-Za-z_][A-Za-z0-9_]*=)/.test(normalised[start])) start++;
  }
  const executable = normalised[start];
  if (executable === undefined) return null;
  const program = basename(executable);
  const args = normalised.slice(start + 1);
  const head = (count: number) => tokens.slice(0, start + count).join(' ');
  if (program === 'eval' || program === 'source' || program === '.') return head(1);
  if (program === 'deno' && args[0] === 'eval') return head(2);
  const inline = /^python[\d.]*$/.test(program) ? DASH_C : INLINE_SCRIPT[program];
  if (!inline && !STDIN_SCRIPT.test(program)) return null;
  const { options, operands } = interpreterOptions(program, args);
  if (inline && options.some(option => inline.test(option))) {
    return head(2 + args.findIndex(arg => inline.test(flagRun(arg, optionValueLetters(program)))));
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
  let start = 0;
  while (start < tokens.length && WRAPPERS.has(basename(tokens[start]))) {
    start++;
    while (start < tokens.length && /^(-|\d)|=/.test(tokens[start])) start++;
  }
  if (start >= tokens.length) return null;
  const program = basename(tokens[start]);
  const args = tokens.slice(start + 1);
  // Any computed argument: `curl https://x/$(base64 a)` sends the file in a GET.
  const computed = raw.slice(start + 1).some(isDynamic);

  if (ALWAYS_OUTBOUND.has(program)) return program;
  if (program === 'curl') {
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
  if (program === 'wget') {
    const flag = args.find(arg => WGET_SENDS.test(arg.split('=')[0]));
    if (flag) return `wget ${flag.split('=')[0]}`;
    if (sendsBody(optionValue(args, ['--method']))) return 'wget --method';
    return computed ? 'wget with a computed argument' : null;
  }
  if (program === 'rsync') {
    return args.some(arg => !arg.startsWith('-') && (/^[^/]*:/.test(arg) || arg.startsWith('rsync://')))
      ? 'rsync to a remote host'
      : null;
  }
  if (program === 'git') {
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
  if (program === 'gh') {
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
  if (program === 'aws' || program === 'gsutil' || program === 'gcloud') {
    const positional = args.filter(arg => !arg.startsWith('-'));
    const copies = positional.some(arg => /^(cp|mv|sync|rsync)$/.test(arg));
    if (copies && /^(s3|gs):\/\//.test(positional.at(-1) ?? '')) return `${program} upload`;
    return positional.includes('put-object') ? `${program} put-object` : null;
  }
  if (program === 'docker' || program === 'podman') {
    return args.find(arg => !arg.startsWith('-')) === 'push' ? `${program} push` : null;
  }
  if (program === 'deno') return args[0] === 'eval' ? 'deno eval' : null;
  if (program === 'eval') return 'eval';
  // A name built from a command substitution carries what it read into the lookup itself.
  if (RESOLVERS.has(program) && computed) return `${program} with a computed argument`;
  const inlineScript = /^python[\d.]*$/.test(program) ? DASH_C : INLINE_SCRIPT[program];
  // A script's own arguments are not options: `python3 x.py -config` never runs an inline script.
  const { options, operands } = interpreterOptions(program, args);
  const inline = inlineScript ? options.find(arg => inlineScript.test(arg)) : undefined;
  if (inline) return `${program} ${(inlineScript?.exec(inline)?.[0] ?? inline.split('=')[0]).replace(/=$/, '')}`;
  // `bash -s` reads its script from stdin even when operands follow, as `curl ... | bash -s -- arg`.
  const scriptOperand =
    INLINE_SCRIPT[program] === SHELL_C && options.some(arg => /^[+-][a-zA-Z]*s/.test(arg)) ? '-' : operands[0];
  if (
    stdin &&
    STDIN_SCRIPT.test(program) &&
    (scriptOperand === undefined || scriptOperand === '-' || STDIN_SCRIPT_ARG.test(scriptOperand))
  ) {
    return `${program} reading a script from stdin`;
  }
  if ((program === 'npm' || program === 'pnpm' || program === 'yarn') && args.includes('publish')) {
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
  return GH_READS[sub]?.has(action) === true;
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
  if (LOCAL_PROGRAMS.has(program)) {
    if (program === 'sort') return !sortRunsOrWrites(args);
    const runs = RUNS_A_PROGRAM[program];
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

/**
 * Every simple command a shell script would run, and every directory outside the project it
 * names. Null when the script does not parse, which the caller treats as a reason to ask.
 *
 * `cd`, `pushd` and `popd` move the directory later commands resolve against, except inside a
 * subshell, a `$( )` or a pipeline, where the shell discards the move. An argument built from a
 * variable or a command substitution is skipped, as opencode does: it cannot be read off the
 * text, and a `cd` to one leaves the tracked directory where it was.
 */
/** Nodes whose assignments are already accounted for: a command's prefix, or a flagged declaration. */
const ASSIGNMENT_OWNERS = new Set(['command', 'declaration_command', 'variable_assignments']);

export async function scanShell(
  command: string,
  startDirectory: string,
  roots: readonly string[]
): Promise<ShellScan | null> {
  const tree = await parseBash(command);
  if (!tree) return null;

  try {
    const temp = [tmpdir(), '/tmp', '/private/tmp'];
    const allowed = [...roots, ...temp];
    const commands: ShellCommand[] = [];
    const paths = new Set<string>([await realpathNearest(startDirectory)]);
    const directories = new Set<string>();
    const envFiles = new Set<string>();
    const outbound = new Set<string>();
    const sends: ShellScan['sends'] = [];
    let setsEnvironment = false;
    const writtenCommands = new Set<number>();
    const writes = new Set<string>();
    const writtenTrees = new Set<string>();
    let contained = true;

    const noteEnvFile = (raw: string): void => {
      const path = expandHome(unquote(raw));
      if (isDynamic(path)) return;
      if (globPrefix(path) === path ? isEnvFile(path) : globMayMatchEnvFile(path)) envFiles.add(path);
    };

    /** A `probe` only reads, so a toolchain folder it names is recorded as a path, not an outside folder to grant. */
    const check = async (raw: string, cwd: string, probe = false): Promise<string | null> => {
      const text = expandHome(unquote(raw));
      const prefix = globPrefix(text);
      if (!prefix || isDynamic(prefix)) return null;
      // A glob can expand to `..` (`~/.nvm*/../.ssh`, `~/.nvm/.?/.ssh`), so a dot after the glob never stays inside.
      const stays = text === prefix || (!text.slice(prefix.length).includes('.') && !prefix.endsWith('.'));
      try {
        const physical = await resolveWithinRootsPhysically(prefix, allowed, cwd);
        paths.add(physical);
        return physical;
      } catch {
        const target = resolve(cwd, prefix);
        paths.add(target);
        paths.add(await realpathNearest(target));
        if (probe && stays && (await isToolchainPath(prefix, cwd))) return target;
        const isDirectory = (await stat(target).catch(() => null))?.isDirectory() === true;
        directories.add(isDirectory ? target : dirname(target));
        return target;
      }
    };

    const state = { cwd: startDirectory, previous: startDirectory, stack: [] as string[] };

    const run = async (node: Node): Promise<void> => {
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
        await changeDirectory(program, rest);
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
      const coverable = !assigns && !writes && !arithmetic && droppedOnlySafeOptions(tokens);
      // Exact rules must name the unsafe syntax too: dropping an assignment or output redirect
      // would let `Bash(git status)` cover `GIT_CONFIG_PARAMETERS=... git status` or a file write.
      const original = node.parent?.type === 'redirected_statement' ? node.parent.text : node.text;
      commands.push({
        text: normalised.join(' '),
        always: `${arityPrefix(normalised).join(' ')} *`,
        coverable,
        // A harmless assignment stays in `words` so a deny or ask rule naming it still matches.
        words: coverable ? [...assignments.map(child => child?.text ?? ''), ...tokens].join(' ') : original,
        ...(opaque ? { opaque } : {}),
      });
      const reason = outboundReason(tokens, readsStdin(node));
      if (reason) {
        outbound.add(reason);
        const computed = tokens.some(isDynamic);
        sends.push({ reason, target: assigns || computed ? null : repositoryWrite(tokens.map(unquote), state.cwd) });
      }
      for (const file of ghReadFiles(tokens.map(unquote))) await check(file, state.cwd);
      if (reason || assigns || arithmetic || !containedCommand(tokens)) contained = false;
      for (const arg of rest) if (!arg.startsWith('-')) noteEnvFile(arg);
      for (const directory of directoryOptionValues(tokens)) await check(directory, state.cwd);
      if (!TOUCHES_FILES.has(program)) {
        // Programs outside the folder-discovery list can still name permission files (sed,
        // awk, dd, ...). Record static operands for the permission-file floor too, including
        // option values, without treating every ordinary argument as an outside folder grant.
        for (const arg of rest) {
          const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg;
          if (value.startsWith('-')) continue;
          const prefix = globPrefix(expandHome(unquote(value)));
          if (!prefix || isDynamic(prefix)) continue;
          const filesystemRoot = parse(resolve(state.cwd, prefix)).root;
          paths.add(await resolveWithinRootsPhysically(prefix, [filesystemRoot], state.cwd));
        }
        return;
      }
      const probe = READ_PROBES.has(program) && containedCommand(tokens);
      for (const arg of rest) {
        if (arg.startsWith('-') || (program === 'chmod' && arg.startsWith('+'))) continue;
        await check(arg, state.cwd, probe);
      }
    };

    const changeDirectory = async (program: string, rest: string[]): Promise<void> => {
      if (program === 'popd') {
        const back = state.stack.pop();
        if (back) {
          state.previous = state.cwd;
          state.cwd = back;
        }
        return;
      }
      const target = rest.find(arg => arg === '-' || !arg.startsWith('-'));
      const next = target === '-' ? state.previous : await check(target ?? homedir(), state.cwd);
      if (next === null) return;
      if (program === 'pushd') state.stack.push(state.cwd);
      state.previous = state.cwd;
      state.cwd = next;
    };

    const noteWrite = (raw: string, into = writes): void => {
      const text = expandHome(unquote(raw));
      if (text && !isDynamic(text) && !HARMLESS_REDIRECT_TARGETS.has(text)) into.add(resolve(state.cwd, text));
    };

    const noteWrites = (program: string, rest: string[]): void => {
      const operands = rest.filter(arg => !arg.startsWith('-'));
      if (program === 'tee') for (const operand of operands) noteWrite(operand);
      for (const [index, arg] of rest.entries()) {
        const output = DOWNLOAD_OUTPUT[program];
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
        noteWrite(rest.includes('--global') ? '~/.gitconfig' : join(repository, '.git/config'));
      }
      if ((program === 'npm' || program === 'pnpm') && sub === 'pkg' && verb !== 'get') noteWrite('package.json');
      if (!COPIES.has(program)) return;
      const option = rest.findIndex(arg => arg === '-t' || arg.startsWith('--target-directory='));
      const target = option === -1 ? operands.at(-1) : (rest[option].split('=')[1] ?? rest[option + 1]);
      if (target === undefined) return;
      noteWrite(target);
      for (const source of operands) if (source !== target) noteWrite(join(unquote(target), basename(unquote(source))));
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
        contained = false;
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
    return {
      commands,
      paths: [...paths],
      directories: [...directories],
      envFiles: [...envFiles],
      outbound: [...outbound],
      sends: setsEnvironment ? sends.map(({ reason }) => ({ reason, target: null })) : sends,
      contained: contained && commands.length > 0,
      writes: [...writes],
      writtenTrees: [...writtenTrees],
    };
  } finally {
    tree.delete();
  }
}

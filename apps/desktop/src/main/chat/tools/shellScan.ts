import { stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { Node } from 'web-tree-sitter';
import { arityPrefix, commandTokens, directoryOptionValues, droppedOnlySafeOptions } from './bashArity';
import { parseBash } from './bashParser';
import { isEnvFile } from './envFiles';
import { resolveWithinRootsPhysically } from './paths';

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
}

export interface ShellScan {
  commands: ShellCommand[];
  /** Directories the command reaches outside every granted root and the temp dirs. */
  directories: string[];
  /** `.env` files named as an argument or an input redirect, which auto mode must not read unasked. */
  envFiles: string[];
  /** Why a command can send data off this computer, e.g. `curl --data`, which auto mode must not run unasked. */
  outbound: string[];
}

const CHANGES_DIRECTORY = new Set(['cd', 'chdir', 'pushd', 'popd']);

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

function unquote(text: string): string {
  if (text.length < 2) return text;
  const first = text[0];
  return (first === '"' || first === "'") && text.at(-1) === first ? text.slice(1, -1) : text;
}

/** `~` and `$HOME` are the user's home, which the shell expands before the program sees it. */
function expandHome(text: string): string {
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

const ALWAYS_OUTBOUND = new Set(['scp', 'sftp', 'ftp', 'nc', 'ncat', 'netcat', 'socat', 'telnet', 'ssh']);

// `-K` reads options from a file, which can hold `--data`.
const CURL_SENDS = /^(-d|--data.*|-F|--form.*|-T|--upload-file|--json|-K|--config)$/;
const WGET_SENDS = /^--(post|body)-(data|file)$/;

/** Options that run a script given inline, which can open a socket no scan of the text sees. */
const DASH_C = /^-[a-zA-Z]*c$/;
const INLINE_SCRIPT: Record<string, RegExp> = {
  node: /^(-e|-p|--eval|--print)(=|$)/,
  ruby: /^-[a-zA-Z]*e$/,
  perl: /^-[a-zA-Z]*[eE]$/,
  php: /^-r$/,
  bun: /^(-e|--eval)(=|$)/,
  osascript: /^-e$/,
  sh: DASH_C,
  bash: DASH_C,
  zsh: DASH_C,
  dash: DASH_C,
};

/** Interpreters that run a script fed on stdin when given no script file: `python3 - <<'EOF'`, `echo x | sh`. */
const STDIN_SCRIPT = /^(python[\d.]*|node|ruby|perl|php|bun|osascript|sh|bash|zsh|dash)$/;

/**
 * Whether a command's stdin is fed: piped into, a heredoc or here-string, or a `<` redirect. A
 * here-string parses as the command's own child, and `cat <<'EOF' | python3` nests the pipe that
 * feeds python3 inside the heredoc redirect, where python3 is that pipeline's first command.
 */
function readsStdin(node: Node): boolean {
  if (node.namedChildren.some(child => child?.type === 'herestring_redirect')) return true;
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
 * has read untrusted content asks before any command at all (see ChatService's DirectoryTurn.untrusted).
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
      else if (!args[i].startsWith('-')) words.push(args[i]);
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
    const fields = args.some(arg => /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(arg));
    return sub === 'api' && (fields || sendsBody(optionValue(args, ['-X', '--method']))) ? 'gh api' : null;
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
  const inline = args.find(arg => (/^python[\d.]*$/.test(program) ? DASH_C : INLINE_SCRIPT[program])?.test(arg));
  if (inline) return `${program} ${inline.split('=')[0]}`;
  if (stdin && STDIN_SCRIPT.test(program) && args.every(arg => arg.startsWith('-'))) {
    return `${program} reading a script from stdin`;
  }
  if ((program === 'npm' || program === 'pnpm' || program === 'yarn') && args.includes('publish')) {
    return `${program} publish`;
  }
  return null;
}

function words(node: Node): string[] {
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
    const directories = new Set<string>();
    const envFiles = new Set<string>();
    const outbound = new Set<string>();
    const writtenCommands = new Set<number>();

    const noteEnvFile = (raw: string): void => {
      const path = expandHome(unquote(raw));
      if (isDynamic(path)) return;
      if (globPrefix(path) === path ? isEnvFile(path) : globMayMatchEnvFile(path)) envFiles.add(path);
    };

    const check = async (raw: string, cwd: string): Promise<string | null> => {
      const prefix = globPrefix(expandHome(unquote(raw)));
      if (!prefix || isDynamic(prefix)) return null;
      try {
        return await resolveWithinRootsPhysically(prefix, allowed, cwd);
      } catch {
        const target = resolve(cwd, prefix);
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

      if (CHANGES_DIRECTORY.has(program)) {
        await changeDirectory(program, rest);
        return;
      }

      const normalised = commandTokens(tokens);
      const assigns = node.namedChildren.some(child => child?.type === 'variable_assignment');
      const writes = writtenCommands.has(node.id) || hasWriteRedirect(node);
      const arithmetic = tokens.some(token => EVALUATES_ARITHMETIC.test(token));
      commands.push({
        text: normalised.join(' '),
        always: `${arityPrefix(normalised).join(' ')} *`,
        coverable: !assigns && !writes && !arithmetic && droppedOnlySafeOptions(tokens),
      });
      const sends = outboundReason(tokens, readsStdin(node));
      if (sends) outbound.add(sends);
      for (const arg of rest) if (!arg.startsWith('-')) noteEnvFile(arg);
      for (const directory of directoryOptionValues(tokens)) await check(directory, state.cwd);
      if (!TOUCHES_FILES.has(program)) return;
      for (const arg of rest) {
        if (arg.startsWith('-') || (program === 'chmod' && arg.startsWith('+'))) continue;
        await check(arg, state.cwd);
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

    const redirect = async (node: Node): Promise<void> => {
      const target = node.childForFieldName('destination');
      if (!target || target.type === 'number') return;
      const text = unquote(target.text);
      if (HARMLESS_REDIRECT_TARGETS.has(text) || text.startsWith('&')) return;
      if (!WRITE_OPERATORS.has(redirectOperator(node) ?? '')) noteEnvFile(target.text);
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
        commands.push({ text: node.text, always: node.text, coverable: false });
        for (const child of node.children) if (child) await visit(child);
        return;
      }
      // `select` parses as a for_statement too; its header rebinds a variable that may be
      // exported, as `for HOME in .` points git at a repo-planted .gitconfig.
      if (node.type === 'for_statement') {
        const body = node.childForFieldName('body');
        const header = body ? node.text.slice(0, body.startIndex - node.startIndex).replace(/[\s;]+$/, '') : node.text;
        commands.push({ text: header, always: header, coverable: false });
        for (const child of node.children) if (child) await visit(child);
        return;
      }
      if (node.type === 'redirected_statement' && hasWriteRedirect(node)) {
        const body = node.childForFieldName('body');
        if (body?.type === 'command') {
          writtenCommands.add(body.id);
        } else {
          commands.push({ text: node.text, always: node.text, coverable: false });
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
    return { commands, directories: [...directories], envFiles: [...envFiles], outbound: [...outbound] };
  } finally {
    tree.delete();
  }
}

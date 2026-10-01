import { stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Node } from 'web-tree-sitter';
import { arityPrefix, commandTokens } from './bashArity';
import { parseBash } from './bashParser';
import { resolveWithinRootsPhysically } from './paths';

export interface ShellCommand {
  /** The command's tokens with options before the subcommand dropped: what a remembered pattern is matched against. */
  text: string;
  /** What "always allow" would remember for it, e.g. `git commit *`. */
  always: string;
}

export interface ShellScan {
  commands: ShellCommand[];
  /** Directories the command reaches outside every granted root and the temp dirs. */
  directories: string[];
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
      commands.push({ text: normalised.join(' '), always: `${arityPrefix(normalised).join(' ')} *` });
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
      await check(target.text, state.cwd);
    };

    const visit = async (node: Node): Promise<void> => {
      if (node.type === 'command') return run(node);
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
    return { commands, directories: [...directories] };
  } finally {
    tree.delete();
  }
}

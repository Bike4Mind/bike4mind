import { resolveWithinRoots } from './paths';
import { resolveCwd } from './shellTools';
import type { ApprovalPrompt, ToolContext } from './types';

/**
 * Whether one gated call is contained enough to run without asking under 'auto'.
 *
 * 'contained' is a claim this module reads off the call itself, not a guess about intent.
 * Everything it cannot read off the call is 'sensitive' and still asks, which is why every
 * decision below is allow-list shaped: a deny list over shell text is exactly the weak detector
 * that makes a reassuring label worse than no label at all.
 *
 * One entry is a judgement rather than a proof and is marked as such where it is made: the
 * package-manager scripts under INERT_COMMANDS run repository code, and the user chose that.
 */
export type ApprovalRisk = 'contained' | 'sensitive';

/**
 * Tools that ask in EVERY mode, including 'full'.
 *
 * These are gated on cost, not on filesystem risk, and the two are separate axes on purpose:
 * a user who has decided the agent may edit their files and run their build has said nothing
 * about spending credits on image generation or on starting an autonomous session.
 *
 * `session_send` is here for the same reason `session_spawn` is, and it is the half of the
 * cycle bound the user holds: every message the agent sends to another conversation is asked
 * about, in every mode, keyed on the target and the text - so a ping-pong cannot run past the
 * first exchange without somebody clicking through each hop of it.
 */
const SPENDS_CREDITS: ReadonlySet<string> = new Set([
  'generate_image',
  'generate_speech',
  'generate_sound_effect',
  'generate_music',
  'session_spawn',
  'session_send',
]);

export function spendsCredits(toolName: string): boolean {
  return SPENDS_CREDITS.has(toolName);
}

/**
 * Anything that could make the shell re-read, re-split or re-route the command.
 *
 * With none of these present the argv is exactly the whitespace split below, which is what
 * makes the per-token checks meaningful. A quote or a `$(` and they stop meaning anything, so
 * their presence alone is enough to send the command to the user.
 *
 * `*` and `?` are in here for the same reason, not because a glob is dangerous: the shell
 * expands it into filenames this module never saw, so the path check below would be asserting
 * containment for arguments that do not exist yet. One of them could be a symlink out.
 */
const SHELL_CONTROL = /[;&|`$(){}<>\\'"~!#[\]*?\n\r]/;

/**
 * Arguments that make any command follow a symlink out of the folder it was pointed at.
 *
 * The path check proves the NAMED path is inside a granted root, and `resolveWithinRoots`
 * resolves a symlink given by name. It cannot speak for a link the command discovers while
 * walking, which is exactly what these turn on.
 */
const FOLLOWS_SYMLINKS: readonly string[] = ['-L', '-R', '--dereference', '--dereference-recursive', '--follow'];

/**
 * The package-manager scripts 'auto' will run unasked.
 *
 * Suffixed variants are in because the real commands are spelled that way - this repo's own
 * check is `lint:check` - and a hand-listed set would be wrong in the next repository. The
 * prefix is anchored, so `turbo:typecheck` does not match: it names a different runner that
 * happens to end in an allowed word, and widening the pattern to reach it would let any script
 * in by choosing its suffix.
 */
const RUNNABLE_SCRIPT = /^(test|lint|typecheck)([:-][a-zA-Z0-9:-]+)?$/;

/**
 * Package-manager flags whose value is the NEXT token, so that token is not the script name.
 *
 * `pnpm --filter <pkg> test` is how a workspace command is actually written, and without this
 * the script would be read as `<pkg>` and the call would ask. The values are still sent through
 * the containment check below like every other token, so `--filter ../../../etc` still asks -
 * a package selector resolves under the cwd and passes, a path that escapes does not.
 *
 * `-w` is deliberately absent: it is a boolean, and consuming a value after it would swallow
 * the script name it precedes.
 */
const SCRIPT_VALUE_FLAGS: readonly string[] = ['--filter', '-F', '-C', '--dir'];

/** Absent `subcommands` and `scripts` means the executable is inert whatever it is asked to do. */
interface InertCommand {
  /** The only first arguments that stay read-only. Anything else asks. */
  subcommands?: readonly string[];
  /** Arguments that turn this command into a write, an exec or a network call. */
  forbiddenArguments?: readonly string[];
  /** Marks a package manager, and bounds the script names it may be asked to run. */
  scripts?: RegExp;
}

/**
 * The executables 'auto' will run unasked, and only those.
 *
 * Two different bars are being applied here, and the difference is the point.
 *
 * For everything without `scripts` the bar is provable inertness: given a fixed argv and path
 * arguments inside a granted root, the program reads and prints, and does not write, execute or
 * open a socket. That still excludes every interpreter and everything that can reach the
 * network.
 *
 * `npm`, `pnpm` and `yarn` do not meet that bar and are here anyway, by an explicit decision of
 * the user's: running a project's own `test`, `lint` and `typecheck` scripts is most of what
 * they want this mode for, and having it ask each time is what made the mode not worth turning
 * on. So the claim made for these three is narrower and worth stating plainly - it is NOT that
 * the call is inert. It is that the script name is one of a bounded few, and that whatever those
 * scripts contain is the repository's own code, which the agent could in principle have just
 * written. Anyone extending this list should hold new entries to the inertness bar unless the
 * user has decided otherwise for them too, the way they did for these.
 *
 * What this does not open: `npx`, `dlx` and `exec` are absent, and absent by default rather than
 * by denial, because they fetch and run a package that is not the repository's at all.
 */
const INERT_COMMANDS: Readonly<Record<string, InertCommand>> = {
  basename: {},
  cat: {},
  cmp: {},
  cut: {},
  date: {},
  diff: {},
  dirname: {},
  du: {},
  echo: {},
  fd: { forbiddenArguments: ['-x', '--exec', '-X', '--exec-batch'] },
  file: {},
  find: { forbiddenArguments: ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprintf', '-fls'] },
  // Read-only porcelain only. `add`, `commit`, `checkout` and `stash` all change the working
  // tree or the index, and `push`, `pull`, `fetch`, `clone`, `remote` and `config` either talk
  // to the network or read a file outside the repository.
  git: {
    subcommands: [
      'status',
      'log',
      'diff',
      'show',
      'branch',
      'blame',
      'describe',
      'shortlog',
      'rev-parse',
      'rev-list',
      'ls-files',
      'ls-tree',
      'cat-file',
    ],
  },
  grep: {},
  head: {},
  ls: {},
  nl: {},
  npm: { scripts: RUNNABLE_SCRIPT },
  pnpm: { scripts: RUNNABLE_SCRIPT },
  pwd: {},
  realpath: {},
  rg: { forbiddenArguments: ['--pre', '--pre-glob', '--hostname-bin'] },
  sort: {},
  stat: {},
  tail: {},
  tr: {},
  tree: {},
  uniq: {},
  wc: {},
  which: {},
  yarn: { scripts: RUNNABLE_SCRIPT },
};

/**
 * Files inside a granted root that something else later EXECUTES.
 *
 * Writing one of these is not the change the user thinks they are approving in bulk: it is a
 * way to have arbitrary code run under their own hands the next time they commit, open a
 * shell, install a package or push a branch. These paths are inside the folders they granted,
 * so the only thing that can catch it is asking.
 */
const EXECUTED_LATER: readonly RegExp[] = [
  /(^|\/)\.git\/hooks\//,
  /(^|\/)\.github\/workflows\//,
  /(^|\/)\.gitlab-ci\.yml$/,
  /(^|\/)\.(bash|zsh)(rc|_profile|_login|env)$/,
  /(^|\/)\.profile$/,
  /(^|\/)\.envrc$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.yarnrc(\.yml)?$/,
  /(^|\/)Library\/LaunchAgents\//,
  /(^|\/)\.claude\//,
  /(^|\/)\.vscode\/tasks\.json$/,
];

/**
 * The part of a token that names a path, or null when it names nothing.
 *
 * `--git-dir=/elsewhere/.git` has to be reduced to its value before it is checked: the whole
 * token resolves relative to a granted cwd and would pass, while the path it actually points
 * at is somewhere else entirely. A bare flag names no path and is skipped.
 */
function pathArgument(token: string): string | null {
  if (token.startsWith('-')) {
    const equals = token.indexOf('=');
    if (equals === -1) return null;
    const value = token.slice(equals + 1);
    return looksLikePath(value) ? value : null;
  }
  return looksLikePath(token) ? token : null;
}

function looksLikePath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('.') || value.includes('/');
}

/**
 * The script a package-manager call is asking for, or null when it is asking for something else.
 *
 * `run` is accepted in front of the name because `npm run lint` and `pnpm lint` are the same
 * request, and a user who writes one form should not be asked while the other is not. Bare
 * `pnpm` reaches this with nothing positional and returns null, which is what keeps an install
 * asking - it is the most consequential thing any of these three does by default.
 */
function runnableScript(rest: readonly string[], allowed: RegExp): string | null {
  const positional: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('-')) {
      positional.push(token);
      continue;
    }
    // `--filter=<pkg>` carries its value in the same token; only the spaced form eats the next.
    if (!token.includes('=') && SCRIPT_VALUE_FLAGS.includes(token)) index += 1;
  }

  const candidate = positional[0] === 'run' ? positional[1] : positional[0];
  return candidate !== undefined && allowed.test(candidate) ? candidate : null;
}

/**
 * Whether a shell command is confined enough to run unasked.
 *
 * Every clause is necessary: no shell control characters, so the argv is fixed; a listed
 * executable, so what it does with that argv is bounded - by inertness for most of the list,
 * and by the script name for the three package managers; and every path argument proven inside
 * a granted root by the same resolver the tools use, so it reaches only what the user shared.
 */
async function assessCommand(input: Record<string, unknown>, context: ToolContext): Promise<ApprovalRisk> {
  const command = typeof input.command === 'string' ? input.command.trim() : '';
  if (!command) return 'sensitive';
  if (SHELL_CONTROL.test(command)) return 'sensitive';

  const tokens = command.split(/\s+/).filter(Boolean);
  const [executable, ...rest] = tokens;
  // A slash in the executable means a path, not a name: `./configure` and `/usr/bin/env` are
  // both ways of running something this list was never asked about.
  if (!executable || executable.includes('/')) return 'sensitive';

  const inert = Object.prototype.hasOwnProperty.call(INERT_COMMANDS, executable)
    ? INERT_COMMANDS[executable]
    : undefined;
  if (!inert) return 'sensitive';

  if (FOLLOWS_SYMLINKS.some(flag => rest.includes(flag))) return 'sensitive';
  if (inert.forbiddenArguments?.some(flag => rest.includes(flag))) return 'sensitive';

  if (inert.subcommands) {
    const subcommand = rest.find(token => !token.startsWith('-'));
    if (!subcommand || !inert.subcommands.includes(subcommand)) return 'sensitive';
  }

  if (inert.scripts && !runnableScript(rest, inert.scripts)) return 'sensitive';

  // Throws when `cwd` is outside every granted root, which is itself a reason to ask.
  const cwd = await resolveCwd(input, context.roots, context.workingDirectory);

  for (const token of rest) {
    const candidate = pathArgument(token);
    if (candidate === null) continue;
    await resolveWithinRoots(candidate, context.roots, cwd);
  }

  return 'contained';
}

/**
 * Where a write tool is about to write, as the gate already resolved it.
 *
 * Taken from the diff rather than re-resolved, because the diff's path is the one the user
 * would have been shown and the one the tool proved was inside a granted root.
 */
function assessWrite(prompt: ApprovalPrompt): ApprovalRisk {
  const path = prompt.diff?.path;
  if (!path) return 'sensitive';
  return EXECUTED_LATER.some(pattern => pattern.test(path)) ? 'sensitive' : 'contained';
}

/**
 * Classify one gated call for 'auto'.
 *
 * Fails closed in three directions, all of which matter more than the convenience:
 *  - an unrecognised tool name is 'sensitive', so a tool added later - an MCP server's, above
 *    all - is asked about until somebody deliberately classifies it here;
 *  - anything thrown while classifying is 'sensitive', so a resolver that cannot answer is
 *    never read as a yes;
 *  - nothing here reads the tool's own description or output, so no text the model or a server
 *    supplies can talk its way into 'contained'.
 */
export async function assessApprovalRisk(
  toolName: string,
  input: Record<string, unknown>,
  prompt: ApprovalPrompt,
  context: ToolContext
): Promise<ApprovalRisk> {
  if (prompt.irreversible) return 'sensitive';
  if (spendsCredits(toolName)) return 'sensitive';

  try {
    switch (toolName) {
      case 'bash_execute':
      case 'bash_background':
        return await assessCommand(input, context);
      case 'file_write':
      case 'file_edit':
        return assessWrite(prompt);
      // Reversible from the same menu it came from, and scoped to the caller's own project.
      case 'session_archive':
        return 'contained';
      default:
        return 'sensitive';
    }
  } catch {
    return 'sensitive';
  }
}

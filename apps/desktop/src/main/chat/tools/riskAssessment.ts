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
 * With none of these present outside quotes, the argv is exactly what the tokenizer below
 * produced, which is what makes the per-token checks meaningful. A `$(` and they stop meaning
 * anything, so its presence alone is enough to send the command to the user.
 *
 * `|` is the one separator deliberately absent: a pipeline is split on it and every segment is
 * assessed in full, which is sound here only because nothing on the allow-list writes to a file
 * and redirection is still rejected right here.
 */
const UNQUOTED_CONTROL = /[;&`$(){}<>\\~!#\n\r]/;

/**
 * Glob characters, rejected unquoted for a different reason than the rest.
 *
 * Not because a glob is dangerous: the shell expands it into filenames this module never saw,
 * so the path check below would be asserting containment for arguments that do not exist yet.
 * One of them could be a symlink out. Quoted, the pattern never becomes a name the shell chose
 * - it reaches the program verbatim - so `find . -name '*.ts'` is fine and `cat *.txt` is not.
 */
const UNQUOTED_GLOB = /[*?[\]]/;

/**
 * What still expands or escapes inside double quotes.
 *
 * Single quotes are literal to the shell, so their contents can be taken as written. Double
 * quotes are not: `"$(id)"` is still a substitution and a backslash still escapes, so a double
 * quoted run holding any of these is not something that can be read off the text.
 */
const DOUBLE_QUOTED_EXPANDS = /[$`\\]/;

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

/** Absent `subcommands`, `scripts` and `guard` means the executable is inert whatever it is asked to do. */
interface InertCommand {
  /** The only first arguments that stay read-only. Anything else asks. */
  subcommands?: readonly string[];
  /** Arguments that turn this command into a write, an exec or a network call. */
  forbiddenArguments?: readonly string[];
  /** The same, for flags that glue their value on with no `=` left to match against. */
  forbiddenPrefixes?: readonly string[];
  /** Marks a package manager, and bounds the script names it may be asked to run. */
  scripts?: RegExp;
  /** For the few whose SHAPE decides whether they write, where no flag list can say it. */
  guard?: (rest: readonly string[]) => boolean;
}

/**
 * Whether `token` is one of `flags`, in either spelling.
 *
 * `--output FILE` and `--output=FILE` are the same flag and the same write, so a check that
 * only compares whole tokens lets the second form straight through.
 */
function isFlag(token: string, flags: readonly string[]): boolean {
  return flags.some(flag => token === flag || token.startsWith(`${flag}=`));
}

function hasFlag(tokens: readonly string[], flags: readonly string[]): boolean {
  return tokens.some(token => isFlag(token, flags));
}

/**
 * Whether any token STARTS with one of `prefixes`, for flags that take no `=` at all.
 *
 * `git grep -O'touch x'` glues its value to the letter, so there is no separate token and no
 * `=` for `isFlag` to find, and that one RUNS the command it is given. Matching the prefix is
 * the only thing that sees it, at the cost of an ask for the rare `git diff -O<orderfile>`.
 */
function hasPrefix(tokens: readonly string[], prefixes: readonly string[]): boolean {
  return tokens.some(token => prefixes.some(prefix => token.startsWith(prefix)));
}

/**
 * The only options allowed BEFORE the subcommand, which is where git's own options go.
 *
 * An allow-list rather than a list of the dangerous ones, because several of git's globals run
 * a program of the caller's choosing and they do not look alike: `git -c diff.external=CMD diff`
 * runs CMD, and so do `-c core.pager` under `--paginate`, `-c alias.*` and `--exec-path`.
 * Finding the subcommand and ignoring everything in front of it is what let `git diff` look
 * read-only while it ran whatever it was handed.
 *
 * `--git-dir` and `--work-tree` are the ones worth saying out loud, because they look harmless
 * and are not: they choose WHICH repository runs, so they choose which config file names the
 * program git runs - and `core.fsmonitor` fires on a bare `git status`. A minimal git dir
 * written anywhere inside a granted root is enough. Nor does the path check catch it:
 * `--git-dir=alt` is a bare name, which `looksLikePath` reads as naming no path at all.
 *
 * `-C <dir>` is absent and costs nothing: its value lands where the subcommand is read from, so
 * `git -C dir status` asked already.
 */
const GIT_SAFE_GLOBALS: readonly string[] = [
  '--no-pager',
  '--no-optional-locks',
  '--no-replace-objects',
  '--literal-pathspecs',
];

/** Everything after `git <subcommand>` that turns a listing into a create, a move or a delete. */
const GIT_BRANCH_WRITES: readonly string[] = [
  '-d',
  '-D',
  '-m',
  '-M',
  '-c',
  '-C',
  '-f',
  '-u',
  '--delete',
  '--move',
  '--copy',
  '--force',
  '--set-upstream-to',
  '--unset-upstream',
  '--edit-description',
];

/**
 * What the subcommand name alone cannot say: the globals in front of it, and the three entries
 * that read in their bare form and not in any other.
 *
 * `git branch` lists, `git branch foo` creates and `git branch -D foo` deletes. `git reflog`
 * shows, while `git reflog expire` and `git reflog delete` drop the entries that are often the
 * only remaining way back to a commit nothing else points at. `git help` prints, and
 * `git help -w` opens a browser. All three are too useful read-only to leave off the list.
 */
function gitStaysReadOnly(rest: readonly string[]): boolean {
  const start = rest.findIndex(token => !token.startsWith('-'));
  if (start === -1) return false;
  if (!rest.slice(0, start).every(token => isFlag(token, GIT_SAFE_GLOBALS))) return false;

  const positional = rest.slice(start).filter(token => !token.startsWith('-'));
  switch (positional[0]) {
    case 'branch':
      return positional.length === 1 && !hasFlag(rest, GIT_BRANCH_WRITES);
    case 'reflog':
      return positional.length === 1 || positional[1] === 'show';
    case 'help':
      return !hasFlag(rest, ['-w', '--web']);
    default:
      return true;
  }
}

/**
 * `xxd [options] [infile [outfile]]` and `uniq [options] [input [output]]` both WRITE the
 * second path they are handed, and no flag names it.
 *
 * So the only bound is the count, and from here a value-taking flag's value looks exactly like
 * a path. Rather than track which flags those are, anything with a second bare token asks:
 * `uniq -f 1 notes.txt` is a false alarm, and a silent write is not.
 */
function writesNoSecondPath(rest: readonly string[]): boolean {
  return rest.filter(token => !token.startsWith('-')).length <= 1;
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
 *
 * The near misses are worth recording, because the next person to extend the list will reach
 * for them. `sed` and `awk` write files - `sed -i`, `s///w file`, awk's `print > "file"` - and
 * awk shells out through `system()`. `env` runs whatever follows its assignments. `less` and
 * `more` are interactive pagers and would hang a child that has no terminal. `curl`, `wget` and
 * `gh` reach the network. Every interpreter is already excluded by the bar above.
 */
const INERT_COMMANDS: Readonly<Record<string, InertCommand>> = {
  base64: { forbiddenArguments: ['-o', '--output'] },
  basename: {},
  cat: {},
  cmp: {},
  column: {},
  comm: {},
  cut: {},
  date: {},
  df: {},
  diff: {},
  dirname: {},
  du: {},
  echo: {},
  expand: {},
  fd: { forbiddenArguments: ['-x', '--exec', '-X', '--exec-batch'] },
  file: {},
  find: {
    forbiddenArguments: ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'],
  },
  fold: {},
  // Read-only porcelain only, and read-only plumbing under it. `add`, `commit`, `checkout` and
  // `stash` all change the working tree or the index, and `push`, `pull`, `fetch`, `clone`,
  // `remote` and `config` either talk to the network or read a file outside the repository.
  //
  // Four more are absent for being read-only only in their bare form, which the subcommand
  // check cannot tell apart from the rest: `tag` lists but `tag X` creates, `remote` lists but
  // `remote add` writes, `worktree` lists but `worktree add` and `remove` write, and
  // `symbolic-ref` reads until it is handed a value. `branch` and `reflog` are the same shape
  // and are on the list anyway, bounded by `guard` instead.
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
      'show-ref',
      'for-each-ref',
      'merge-base',
      'name-rev',
      'grep',
      'count-objects',
      'whatchanged',
      'reflog',
      'check-ignore',
      'diff-tree',
      'verify-commit',
      'var',
      'help',
    ],
    // `git diff --output=FILE` writes that file, and `git grep -O<cmd>` RUNS one. The long
    // spelling of the second is here; the glued short one needs the prefix check.
    forbiddenArguments: ['--output', '--open-files-in-pager'],
    forbiddenPrefixes: ['-O'],
    guard: gitStaysReadOnly,
  },
  grep: {},
  head: {},
  hostname: {},
  id: {},
  join: {},
  jq: {},
  ls: {},
  md5: {},
  md5sum: {},
  nl: {},
  npm: { scripts: RUNNABLE_SCRIPT },
  od: {},
  paste: {},
  pnpm: { scripts: RUNNABLE_SCRIPT },
  printenv: {},
  ps: {},
  pwd: {},
  realpath: {},
  rev: {},
  rg: { forbiddenArguments: ['--pre', '--pre-glob', '--hostname-bin'] },
  seq: {},
  sha256sum: {},
  shasum: {},
  // `sort -o FILE` writes that file, and GNU `sort --compress-program=PROG` runs PROG as soon
  // as the input is big enough to spill to a temp file.
  sort: { forbiddenArguments: ['-o', '--output', '--compress-program'] },
  stat: {},
  sw_vers: {},
  tail: {},
  tr: {},
  tree: { forbiddenArguments: ['-o'] },
  uname: {},
  uniq: { guard: writesNoSecondPath },
  uptime: {},
  wc: {},
  which: {},
  whoami: {},
  xxd: { guard: writesNoSecondPath },
  yarn: { scripts: RUNNABLE_SCRIPT },
};

/**
 * Files inside a granted root that something else later EXECUTES.
 *
 * Writing one of these is not the change the user thinks they are approving in bulk: it is a
 * way to have arbitrary code run under their own hands the next time they commit, open a
 * shell, install a package or push a branch. These paths are inside the folders they granted,
 * so the only thing that can catch it is asking.
 *
 * Every pattern carries `i`, and a new one has to as well: macOS and Windows will open
 * `.GIT/config` as `.git/config`, so a pattern that matches only the lower-case spelling
 * guards nothing on the two platforms this app ships to.
 */
const EXECUTED_LATER: readonly RegExp[] = [
  // The whole directory, and the gitfile that can stand in for it. Hooks are the obvious half;
  // `config` is the other, since `core.fsmonitor`, `diff.external`, `core.pager` and `alias.*`
  // each NAME a command git runs, and `core.fsmonitor` fires on a bare `git status` - which is
  // on the allow-list above. A `.git` FILE holding `gitdir: ../elsewhere` reaches a config the
  // same way, verified. Nothing legitimate asks to write in here unasked.
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)\.github\/workflows\//i,
  /(^|\/)\.gitlab-ci\.yml$/i,
  /(^|\/)\.(bash|zsh)(rc|_profile|_login|env)$/i,
  /(^|\/)\.profile$/i,
  /(^|\/)\.envrc$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.yarnrc(\.yml)?$/i,
  /(^|\/)Library\/LaunchAgents\//i,
  /(^|\/)\.claude\//i,
  /(^|\/)\.vscode\/tasks\.json$/i,
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
 * The command as argv, one array per pipeline segment, or null when it cannot be read safely.
 *
 * Returning null is the fail-closed half of this module: anything the tokenizer is not certain
 * it has read the way the shell will read it ends up in front of the user, and the per-token
 * checks below only ever run on an argv this produced.
 *
 * Quoting is handled rather than refused because refusing it is what made `grep "foo bar" x`
 * and `find . -name '*.ts'` ask. Single quotes are literal to the shell, so their contents are
 * taken as written; double quotes are only taken when nothing inside them still expands.
 */
function tokenizeCommand(command: string): string[][] | null {
  const segments: string[][] = [];
  let current: string[] = [];
  let token: string | null = null;

  const endToken = () => {
    if (token !== null) current.push(token);
    token = null;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if (char === "'" || char === '"') {
      const close = command.indexOf(char, index + 1);
      if (close === -1) return null;
      const body = command.slice(index + 1, close);
      if (char === '"' && DOUBLE_QUOTED_EXPANDS.test(body)) return null;
      token = (token ?? '') + body;
      index = close;
      continue;
    }

    if (char === '|') {
      endToken();
      segments.push(current);
      current = [];
      continue;
    }

    if (UNQUOTED_CONTROL.test(char) || UNQUOTED_GLOB.test(char)) return null;

    if (/\s/.test(char)) {
      endToken();
      continue;
    }

    token = (token ?? '') + char;
  }

  endToken();
  segments.push(current);
  // An empty segment is a leading, trailing or doubled separator, and `||` is not a pipe at all.
  return segments.some(segment => segment.length === 0) ? null : segments;
}

/**
 * Whether one segment of a pipeline is confined enough to run unasked.
 *
 * Every clause is necessary: a listed executable, so what it does with its argv is bounded - by
 * inertness for most of the list, and by the script name for the three package managers; and
 * every path argument proven inside a granted root by the same resolver the tools use, so it
 * reaches only what the user shared. `resolveWithinRoots` throws rather than returning, and the
 * caller treats that as a reason to ask.
 */
async function assessSegment(tokens: readonly string[], cwd: string, context: ToolContext): Promise<boolean> {
  const [executable, ...rest] = tokens;
  // A slash in the executable means a path, not a name: `./configure` and `/usr/bin/env` are
  // both ways of running something this list was never asked about.
  if (!executable || executable.includes('/')) return false;

  const inert = Object.prototype.hasOwnProperty.call(INERT_COMMANDS, executable)
    ? INERT_COMMANDS[executable]
    : undefined;
  if (!inert) return false;

  if (hasFlag(rest, FOLLOWS_SYMLINKS)) return false;
  if (inert.forbiddenArguments && hasFlag(rest, inert.forbiddenArguments)) return false;
  if (inert.forbiddenPrefixes && hasPrefix(rest, inert.forbiddenPrefixes)) return false;

  if (inert.subcommands) {
    const subcommand = rest.find(token => !token.startsWith('-'));
    if (!subcommand || !inert.subcommands.includes(subcommand)) return false;
  }

  if (inert.guard && !inert.guard(rest)) return false;
  if (inert.scripts && !runnableScript(rest, inert.scripts)) return false;

  for (const token of rest) {
    const candidate = pathArgument(token);
    if (candidate === null) continue;
    await resolveWithinRoots(candidate, context.roots, cwd);
  }

  return true;
}

/**
 * Whether a shell command is confined enough to run unasked.
 *
 * A pipeline is contained only when every segment of it is, and that is sound for one reason
 * worth stating: nothing on the allow-list writes to a file, so no chain of them can either,
 * and the one way to turn a chain into a write - a redirect - is rejected while tokenizing.
 * Reading `git log | head` is the same act as reading `git log`, only shorter on screen.
 */
async function assessCommand(input: Record<string, unknown>, context: ToolContext): Promise<ApprovalRisk> {
  const command = typeof input.command === 'string' ? input.command.trim() : '';
  if (!command) return 'sensitive';

  const segments = tokenizeCommand(command);
  if (!segments) return 'sensitive';

  // Throws when `cwd` is outside every granted root, which is itself a reason to ask.
  const cwd = await resolveCwd(input, context.roots, context.workingDirectory);

  for (const segment of segments) {
    if (!(await assessSegment(segment, cwd, context))) return 'sensitive';
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
  // The path arrives from `resolve`, which on Windows spells its separators `\`. Every pattern
  // below is written in posix, so without this they match nothing at all on that platform.
  const separated = path.replace(/\\/g, '/');
  return EXECUTED_LATER.some(pattern => pattern.test(separated)) ? 'sensitive' : 'contained';
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

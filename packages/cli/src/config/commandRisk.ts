import { parse as shellParse } from 'shell-quote';

/**
 * Parse-based shell command risk classification.
 *
 * Tool-name-based safety (see {@link ./toolSafety}) treats every `bash_execute`
 * call identically, so a destructive command hidden behind a wrapper
 * (`sh -c "rm -rf /"`, `sudo bash -c "..."`, `curl ... | sh`) is indistinguishable
 * from a benign `ls`. This module inspects the *command text* with a real shell
 * tokenizer (shell-quote) and raises the risk level accordingly.
 *
 * Design constraints (see issue #200):
 * - Pure, synchronous function so the same classifier can feed the permission
 *   prompt, the sandbox decision, and any headless policy check.
 * - Only ever TIGHTENS classification (raises risk); never relaxes it.
 * - Unparseable input is treated as elevated risk (fail closed).
 */

/**
 * Command risk levels, ordered from least to most dangerous.
 * - `low`: read-only / benign (`ls`, `cat foo`).
 * - `medium`: mutates state but not obviously catastrophic (unknown programs, plain writes).
 * - `high`: destructive, fetch-and-execute, privilege escalation, or unparseable.
 */
export type CommandRiskLevel = 'low' | 'medium' | 'high';

const RISK_ORDER: Record<CommandRiskLevel, number> = { low: 0, medium: 1, high: 2 };

/** Result of classifying a single command string. */
export type CommandRiskAssessment = {
  level: CommandRiskLevel;
  /** Human-readable justifications for the assigned level (empty when `low`). */
  reasons: string[];
};

/**
 * Wrapper programs that execute another program passed as their arguments.
 * They are transparent to risk: we skip the wrapper (and its own options) and
 * classify the underlying program instead.
 */
const COMMAND_WRAPPERS = new Set([
  'env',
  'nice',
  'nohup',
  'setsid',
  'stdbuf',
  'ionice',
  'time',
  'timeout',
  'command',
  'builtin',
  'exec',
  'xargs',
  'nixio',
  // Namespace / rootfs / sandbox launchers: `<prog> [opts] COMMAND [args]` execs COMMAND.
  'chroot',
  'nsenter',
  'unshare',
  'fakeroot',
  'proot',
  // Repeat/lock launchers: run the trailing command.
  'watch',
  'flock',
  // Multi-call binaries: `busybox rm -rf /`, `toybox dd ...` dispatch to a built-in applet
  // that is the real (possibly destructive) command. Skipping the dispatcher re-exposes it.
  'busybox',
  'toybox',
]);

/** Privilege-escalation programs: elevated on their own, transparent to the inner program. */
const PRIVILEGE_ESCALATION = new Set(['sudo', 'doas', 'su', 'runuser', 'pkexec', 'setpriv']);

/**
 * Programs that run their target command via a `-c`/`--command` value (like an
 * interpreter's `-c`, but the program itself is not a shell): `script -c "<cmd>"`,
 * `flock <file> -c "<cmd>"`. The command string is recursed. (`su`/`runuser` have their
 * own escalator branch that also adds a privilege-escalation bump.)
 */
const COMMAND_FLAG_RUNNERS = new Set(['script', 'flock']);

/**
 * Flags that consume the following token as their value, scoped PER PROGRAM.
 *
 * This must not be a global set: `-i`/`-s`/`-e`/`-k` are *value* flags for some
 * programs but *boolean* flags for `sudo`/`env` (e.g. `sudo -i` = login shell,
 * `env -i` = ignore environment). A global set would consume the real program as
 * a bogus "value" - e.g. `env -i rm -rf /` would drop `rm` and classify `low`.
 * Anything not listed for a program is treated as a boolean flag (consumes only
 * itself), which fails safe: we stop at the real program rather than skip past it.
 */
const PROGRAM_VALUE_FLAGS: Record<string, Set<string>> = {
  // sudo: -i/-s/-e/-k/-n/-b/-E/-H/-P/-S/-v are boolean; only these take a value.
  sudo: new Set([
    '-u',
    '--user',
    '-g',
    '--group',
    '-U',
    '-p',
    '--prompt',
    '-C',
    '--close-from',
    '-D',
    '--chdir',
    '-h',
    '--host',
    '-r',
    '--role',
    '-t',
    '--type',
    '-R',
    '--chroot',
    '-a',
    '--auth-type',
  ]),
  doas: new Set(['-u', '-C', '-a']),
  // su/runuser: -c (command) is handled by the early escalator recursion; -s takes a
  // shell. runuser additionally takes `-u`/`--user` (util-linux `runuser -u <user> <cmd>`);
  // without it the username would be read as the inner program and the real command missed.
  su: new Set(['-s', '--shell', '-g', '--group', '-G', '--supp-group']),
  runuser: new Set(['-s', '--shell', '-g', '--group', '-G', '--supp-group', '-u', '--user']),
  pkexec: new Set(['--user']),
  // setpriv: only the flags that take a separate value (`--reuid 0`). Boolean flags
  // (`--reset-env`, `--keep-groups`, `--no-new-privs`, ...) are intentionally omitted -
  // listing one would consume the real program as its bogus "value".
  setpriv: new Set([
    '--reuid',
    '--regid',
    '--groups',
    '--inh-caps',
    '--ambient-caps',
    '--bounding-set',
    '--securebits',
    '--pdeathsig',
    '--selinux-label',
    '--apparmor-profile',
  ]),
  // chroot: NEWROOT is a positional (see WRAPPERS_WITH_POSITIONAL); only these long
  // options take a separate value when not given in `--opt=value` form.
  chroot: new Set(['--userspec', '--groups']),
  // nsenter: -t/--target take a PID; -S/-G take a uid/gid. Namespace flags (-m/-u/-i/...) are boolean.
  nsenter: new Set(['-t', '--target', '-S', '--setuid', '-G', '--setgid']),
  // unshare: -S/-G take a uid/gid; --map-user/--map-group take a value. Namespace flags are boolean.
  unshare: new Set(['-S', '--setuid', '-G', '--setgid', '--map-user', '--map-group']),
  // watch: -n/--interval takes seconds; other flags are boolean.
  watch: new Set(['-n', '--interval']),
  // flock: the lockfile is a positional (see WRAPPERS_WITH_POSITIONAL); -w/-E take a value.
  // -c (command) is handled by the COMMAND_FLAG_RUNNERS recursion, not here.
  flock: new Set(['-w', '--timeout', '-E', '--conflict-exit-code']),
  // env: -i/-0/-v are boolean; -u unsets a var, -C changes dir, -S splits a string.
  env: new Set([
    '-u',
    '--unset',
    '-C',
    '--chdir',
    '-S',
    '--split-string',
    '--block-signal',
    '--default-signal',
    '--ignore-signal',
  ]),
  nice: new Set(['-n', '--adjustment']),
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  ionice: new Set(['-c', '--class', '-n', '--classdata', '-p', '--pid', '-P', '--pgid', '-u', '--uid']),
  stdbuf: new Set(['-i', '--input', '-o', '--output', '-e', '--error']),
  xargs: new Set([
    '-I',
    '-i',
    '-n',
    '--max-args',
    '-P',
    '--max-procs',
    '-s',
    '--max-chars',
    '-d',
    '--delimiter',
    '-E',
    '-a',
    '--arg-file',
    '-L',
    '--max-lines',
  ]),
};

const NO_VALUE_FLAGS: Set<string> = new Set();

/**
 * Wrappers that take one bare positional argument before the command:
 * `timeout 5 <cmd>` (duration), `chroot /newroot <cmd>`, `flock /lock <cmd>`.
 */
const WRAPPERS_WITH_POSITIONAL = new Set(['timeout', 'chroot', 'flock']);

/**
 * Shell / language interpreters. Relevant in two ways:
 * - As a pipeline sink for fetch-and-execute (`curl ... | sh`).
 * - As `-c`/`-e` wrappers whose code argument must be recursively classified.
 */
const INTERPRETERS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'ash',
  'csh',
  'tcsh',
  'fish',
  'pwsh',
  'powershell',
  'python',
  'python2',
  'python3',
  'perl',
  'ruby',
  'node',
  'nodejs',
  'php',
]);

/**
 * Interpreters for which `-e` means "evaluate this string as code" (rather than a
 * shell option like `errexit`). Only these get `-e` treated as an inline-code flag.
 */
const EVAL_E_INTERPRETERS = new Set(['perl', 'ruby', 'node', 'nodejs']);

/** Builtins that execute a file/stream in the current shell (`source x`, `. x`). */
const SOURCE_BUILTINS = new Set(['source', '.']);

/**
 * Programs that consume and execute piped/substituted content - the "execute" half of
 * fetch-and-execute. Interpreters plus `source`/`.` (which run fetched content directly),
 * so `curl x | sh`, `bash <(curl x)`, and `source <(curl x)` are all caught.
 */
const FETCH_SINK_PROGRAMS = new Set([...INTERPRETERS, ...SOURCE_BUILTINS]);

/** Privilege-escalation programs that run their target command via `-c "<cmd>"`. */
const ESCALATORS_WITH_COMMAND_FLAG = new Set(['su', 'runuser']);

/** Programs that fetch content over the network (the source half of fetch-and-execute). */
const NETWORK_FETCHERS = new Set(['curl', 'wget', 'fetch', 'aria2c', 'lwp-download']);

/**
 * Programs that are destructive regardless of their arguments (raw disk / filesystem
 * destruction). These always classify as high.
 */
const ALWAYS_DESTRUCTIVE = new Set([
  'mkfs',
  'dd',
  'shred',
  'fdisk',
  'sfdisk',
  'parted',
  'wipefs',
  'blkdiscard',
  'sgdisk',
]);

/**
 * Short-flag letters that make `rm` recursive or forced, and the long forms.
 * Matched by decomposing a short-flag bundle into its letters (see
 * {@link shortFlagContains}) rather than enumerating orderings, so `-rf`, `-fr`,
 * `-Rvf`, `-vfr`, ... are all covered in one shot.
 */
const RM_DANGEROUS_SHORT_FLAGS = /[rRf]/;
const RM_DANGEROUS_LONG_FLAGS = new Set(['--recursive', '--force']);

/** Short-flag letters that make chmod/chown/chgrp recursive (`-R`, `-r`). */
const RECURSIVE_SHORT_FLAGS = /[Rr]/;

/**
 * True if `flag` is a single-dash short-flag bundle (`-Rf`, `-vrf`) containing any
 * letter matched by `letters`. Double-dash long flags never match here - the caller
 * matches those against an explicit set. Decomposing the bundle catches every
 * ordering/combination (`-rf`, `-fr`, `-vRf`, ...) that whole-string equality misses.
 */
function shortFlagContains(flag: string, letters: RegExp): boolean {
  return flag.startsWith('-') && !flag.startsWith('--') && letters.test(flag.slice(1));
}

/**
 * Extract the command string carried by a `-c`/`--command` flag appearing after
 * `startIndex` in `args`. Handles every documented form: separate value
 * (`-c CMD`, `--command CMD`), GNU combined long form (`--command=CMD`, which
 * shell-quote emits as a single `--command=rm -rf /` token), and combined short
 * form (`-cCMD`). Returns the code string, or `null` if no command flag is found.
 */
function commandFlagValue(args: string[], startIndex: number): string | null {
  for (let i = startIndex + 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-c' || arg === '--command') {
      return i + 1 < args.length ? args[i + 1] : null;
    }
    if (arg.startsWith('--command=')) return arg.slice('--command='.length);
    if (arg.startsWith('-c') && !arg.startsWith('--') && arg.length > 2) return arg.slice(2);
  }
  return null;
}

/**
 * Collect every candidate inline-code string carried by an interpreter's code flag
 * (`-c` for all interpreters, plus `-e` for eval-style ones). Because the classifier
 * is tighten-only, returning every plausible source and taking the max risk over them
 * is always safe:
 *   - `-c CODE` / `--command CODE`  -> the following token
 *   - `-c"CODE"` (glued; shell-quote emits `-cCODE`)  -> the tail after the flag letter
 *   - `-ecCODE` / `-exc CODE` (bundles)  -> BOTH the tail after the code-flag letter and
 *      the following token, since either may hold the command depending on the shell.
 * `letters` is the code-flag letter set for this interpreter (`/c/` or `/[ce]/`).
 * Whole-string equality (`arg === '-c'`) misses every glued/bundled form.
 */
function interpreterCodeCandidates(inner: string[], letters: RegExp): string[] {
  const candidates: string[] = [];
  for (let i = 1; i < inner.length; i += 1) {
    const arg = inner[i];
    if (arg === '--command') {
      if (i + 1 < inner.length) candidates.push(inner[i + 1]);
      continue;
    }
    if (arg.startsWith('--command=')) {
      candidates.push(arg.slice('--command='.length));
      continue;
    }
    if (!shortFlagContains(arg, letters)) continue;
    const body = arg.slice(1); // strip the leading '-'
    const tail = body.slice(body.search(letters) + 1); // code glued after the flag letter
    if (tail.length > 0) candidates.push(tail);
    if (i + 1 < inner.length) candidates.push(inner[i + 1]); // or supplied as the next token
  }
  return candidates;
}

/**
 * Extract the command string carried by `env`'s `-S`/`--split-string` flag, or
 * `null` if no `env` in the command carries one. Handles separate value (`-S CMD`),
 * combined long form (`--split-string=CMD`), and combined short form (`-SCMD`).
 *
 * Scans EVERY `env` occurrence, not just the first: chains that put a wrapper, an
 * env-assignment, or a boolean flag between two envs - `env env -S "..."`,
 * `env FOO=bar env -S "..."`, `env -i env -S "..."`, `env sudo env -S "..."` - would
 * otherwise slip past a single-env scan and get the payload swallowed as a flag value
 * by the generic wrapper-skip. For each env we walk its own flags (consuming the
 * values of its value flags, e.g. `-u FOO`) until the split-string flag or the inner
 * program; hitting the inner program moves on to the next env rather than giving up.
 */
function envSplitStringValue(args: string[]): string | null {
  const envValueFlags = PROGRAM_VALUE_FLAGS.env;
  for (let envIndex = 0; envIndex < args.length; envIndex += 1) {
    if (programName(args[envIndex]) !== 'env') continue;
    for (let i = envIndex + 1; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === '-S' || arg === '--split-string') {
        return i + 1 < args.length ? args[i + 1] : null;
      }
      if (arg.startsWith('--split-string=')) return arg.slice('--split-string='.length);
      if (arg.startsWith('-S') && !arg.startsWith('--') && arg.length > 2) return arg.slice(2);
      if (!arg.startsWith('-')) break; // inner program for this env; try the next env occurrence
      if (envValueFlags.has(arg)) i += 1; // this flag consumes the next token as its value
    }
  }
  return null;
}

/**
 * Path arguments that make an `rm` catastrophic: filesystem root, home, or things
 * that expand to a broad tree.
 */
const RM_DANGEROUS_TARGETS = new Set(['/', '/*', '~', '~/', '*', '.', './', '..', '../', '$HOME', '${HOME}']);

/** Strip a leading path so `/bin/rm` and `rm` compare equal. */
function programName(token: string): string {
  const withoutPath = token.slice(token.lastIndexOf('/') + 1);
  return withoutPath.toLowerCase();
}

/** Take the higher of two risk levels. */
function maxLevel(a: CommandRiskLevel, b: CommandRiskLevel): CommandRiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

/** A parsed shell token: a literal string, or a structured operator/glob/comment entry. */
type ShellToken = ReturnType<typeof shellParse>[number];

function isOperator(token: ShellToken): token is { op: string } {
  return typeof token === 'object' && token !== null && 'op' in token;
}

function asString(token: ShellToken): string | null {
  if (typeof token === 'string') return token;
  // shell-quote emits globs as { op: 'glob', pattern }. Keep the pattern so
  // dangerous glob targets (e.g. `rm -rf /*`) are still visible.
  if (typeof token === 'object' && token !== null && 'pattern' in token) {
    return (token as { pattern: string }).pattern;
  }
  return null;
}

/**
 * Control operators that separate one simple command from the next. Subshell and
 * command/process-substitution parens are included so a destructive program hidden
 * inside `$(...)`, `(...)`, or `<(...)` still lands in its own analyzable segment.
 */
const SEGMENT_OPERATORS = new Set(['|', '||', '&&', ';', '&', '\n', '|&', '(', ')', '<(', '>(']);

/** A `VAR=value` environment assignment (precedes the program in `env FOO=bar cmd`). */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Skip leading wrapper (`env`, `timeout`, ...) and privilege-escalation (`sudo`, ...)
 * programs along with their options, returning the index of the real program.
 * `onPrivEscalation` is invoked once per escalation program encountered.
 */
function skipToInnerProgram(args: string[], onPrivEscalation?: (prog: string) => void): number {
  let index = 0;

  while (index < args.length) {
    const prog = programName(args[index]);
    const isPrivEsc = PRIVILEGE_ESCALATION.has(prog);
    const isWrapper = COMMAND_WRAPPERS.has(prog);
    if (!isPrivEsc && !isWrapper) break;

    if (isPrivEsc) onPrivEscalation?.(prog);
    index += 1;

    const valueFlags = PROGRAM_VALUE_FLAGS[prog] ?? NO_VALUE_FLAGS;
    let positionalToSkip = WRAPPERS_WITH_POSITIONAL.has(prog) ? 1 : 0;
    while (index < args.length) {
      const arg = args[index];
      if (arg.startsWith('-')) {
        index += 1;
        // Consume the value of a value-taking flag for THIS program (`-n 10`, `-u root`).
        if (valueFlags.has(arg) && index < args.length) index += 1;
        continue;
      }
      if (ENV_ASSIGNMENT.test(arg)) {
        index += 1;
        continue;
      }
      if (positionalToSkip > 0) {
        positionalToSkip -= 1;
        index += 1;
        continue;
      }
      break;
    }
  }

  return index;
}

/**
 * Classify a single simple command (no control operators), given as its literal
 * argument list. Handles wrapper/privilege-escalation unwrapping and recursion
 * into `-c` interpreter code and `eval` arguments.
 */
function classifySimpleCommand(args: string[], reasons: string[], depth: number): CommandRiskLevel {
  let level: CommandRiskLevel = 'low';

  // `su`/`runuser` carry their target command via `-c "<cmd>"`. Recurse into that
  // string BEFORE the generic wrapper-skip, which would otherwise consume `-c` and
  // its value as a flag pair and hide the real command.
  const escalatorIndex = args.findIndex(arg => ESCALATORS_WITH_COMMAND_FLAG.has(programName(arg)));
  if (escalatorIndex !== -1) {
    const code = commandFlagValue(args, escalatorIndex);
    if (code !== null) {
      reasons.push(`privilege escalation via '${programName(args[escalatorIndex])}'`);
      const nested = classifyAtDepth(code, depth + 1);
      reasons.push(...nested.reasons);
      return maxLevel('medium', nested.level);
    }
  }

  // Non-shell programs that run a command via `-c "<cmd>"` (`script -c`, `flock <file> -c`).
  // Recurse into the command string, same as the escalator branch but with no privilege bump.
  const cmdRunnerIndex = args.findIndex(arg => COMMAND_FLAG_RUNNERS.has(programName(arg)));
  if (cmdRunnerIndex !== -1) {
    const code = commandFlagValue(args, cmdRunnerIndex);
    if (code !== null) {
      reasons.push(`inline command executed via '${programName(args[cmdRunnerIndex])} -c'`);
      const nested = classifyAtDepth(code, depth + 1);
      reasons.push(...nested.reasons);
      return maxLevel(level, nested.level);
    }
  }

  // `env -S "<cmd>"` (split-string) parses its argument as a full argv and runs it -
  // functionally an interpreter's `-c`. `-S`/`--split-string` is a value flag on env,
  // so the generic wrapper-skip would consume the command string as a flag value and
  // leave `inner` empty (classified `low`). Recurse into the string first.
  const splitString = envSplitStringValue(args);
  if (splitString !== null) {
    reasons.push("split-string execution via 'env -S'");
    const nested = classifyAtDepth(splitString, depth + 1);
    reasons.push(...nested.reasons);
    return maxLevel(level, nested.level);
  }

  const index = skipToInnerProgram(args, prog => {
    level = maxLevel(level, 'medium');
    reasons.push(`privilege escalation via '${prog}'`);
  });

  const inner = args.slice(index);
  if (inner.length === 0) return level;

  const prog = programName(inner[0]);

  // Interpreter with inline code (`sh -c "..."`, `python -c "..."`): the code
  // string is the real command - recurse into it. `-e` is only inline code for
  // eval-style interpreters (`perl -e`); for shells it means `errexit`.
  if (INTERPRETERS.has(prog)) {
    // Code-flag letters: `-c` for every interpreter, plus `-e` (evaluate) for
    // eval-style ones. `interpreterCodeCandidates` decomposes short-flag bundles and
    // handles glued code (`bash -c"rm -rf /"`), so `bash -ec "..."`, `sh -exc "..."`,
    // and `node -e"..."` are all caught - whole-string equality misses every form.
    const codeFlagLetters = EVAL_E_INTERPRETERS.has(prog) ? /[ce]/ : /c/;
    const codeCandidates = interpreterCodeCandidates(inner, codeFlagLetters);
    if (codeCandidates.length > 0) {
      reasons.push(`inline code executed via '${prog}'`);
      for (const code of codeCandidates) {
        const nested = classifyAtDepth(code, depth + 1);
        reasons.push(...nested.reasons);
        level = maxLevel(level, nested.level);
      }
      return level;
    }
  }

  // `eval <string...>`: the remaining arguments form a command string.
  if (prog === 'eval' && inner.length > 1) {
    reasons.push("dynamic evaluation via 'eval'");
    const nested = classifyAtDepth(inner.slice(1).join(' '), depth + 1);
    reasons.push(...nested.reasons);
    return maxLevel(level, nested.level);
  }

  // Raw disk / filesystem destroyers: always high.
  if (ALWAYS_DESTRUCTIVE.has(prog) || prog.startsWith('mkfs.')) {
    reasons.push(`destructive command '${prog}'`);
    return maxLevel(level, 'high');
  }

  // `tee /dev/<disk>` writes to a raw block device with no redirection operator,
  // so the redirect-based check below never sees it. Plain `tee foo.txt` is benign,
  // so this fires only on a block-device positional argument.
  if (prog === 'tee' && inner.slice(1).some(arg => !arg.startsWith('-') && BLOCK_DEVICE_RE.test(arg))) {
    reasons.push('write to a raw block device via tee');
    return maxLevel(level, 'high');
  }

  // `rm`: high when recursive/forced or aimed at a catastrophic target; otherwise a plain mutation.
  if (prog === 'rm') {
    const flags = inner.slice(1).filter(arg => arg.startsWith('-'));
    const targets = inner.slice(1).filter(arg => !arg.startsWith('-'));
    const recursiveOrForced = flags.some(
      flag => shortFlagContains(flag, RM_DANGEROUS_SHORT_FLAGS) || RM_DANGEROUS_LONG_FLAGS.has(flag)
    );
    const catastrophicTarget = targets.some(target => RM_DANGEROUS_TARGETS.has(target));
    if (recursiveOrForced || catastrophicTarget) {
      reasons.push(`destructive 'rm'${catastrophicTarget ? ' targeting a critical path' : ' (recursive/forced)'}`);
      return maxLevel(level, 'high');
    }
    reasons.push("file removal via 'rm'");
    return maxLevel(level, 'medium');
  }

  // Recursive ownership/permission changes are destructive (can brick a tree).
  if (
    (prog === 'chmod' || prog === 'chown' || prog === 'chgrp') &&
    inner.some(arg => shortFlagContains(arg, RECURSIVE_SHORT_FLAGS) || arg === '--recursive')
  ) {
    reasons.push(`recursive '${prog}'`);
    return maxLevel(level, 'high');
  }

  return level;
}

/**
 * Detect a fork bomb: a shell function that recursively calls itself and
 * backgrounds the call, e.g. `:(){ :|:& };:`. shell-quote does not model function
 * definitions, so this is matched structurally on the collapsed token stream.
 */
function looksLikeForkBomb(command: string): boolean {
  // Normalize whitespace, then look for the `<name>(){ ... <name>|<name>& ... };<name>` shape.
  const compact = command.replace(/\s+/g, '');
  // Bound the input: the pattern's backreference + greedy quantifiers can backtrack,
  // and real fork bombs are tiny - a multi-KB command is never one.
  if (compact.length > 512) return false;
  return /([A-Za-z_:][\w:]*)\(\)\{.*\1[|&]\1.*&.*\};\1/.test(compact);
}

/**
 * Hard bounds that keep the classifier's recursion (into `eval`, interpreter `-c`,
 * `su -c`, `env -S`) bounded in time and stack. Wrapper/interpreter nesting in a
 * real command is only ever a few levels deep, so a command that blows past these
 * is either adversarial or pathological - either way, fail closed (classify `high`).
 */
const MAX_RECURSION_DEPTH = 25;
const MAX_COMMAND_LENGTH = 100_000;

/**
 * Classify the risk of a shell command string.
 *
 * Pure and synchronous. Never throws: a command that cannot be tokenized, is
 * absurdly long, or nests deeper than {@link MAX_RECURSION_DEPTH} is treated as
 * `high` (fail closed).
 */
export function classifyCommandRisk(command: string): CommandRiskAssessment {
  return classifyAtDepth(command, 0);
}

function classifyAtDepth(command: string, depth: number): CommandRiskAssessment {
  // Bail before recursing further: unbounded nesting (e.g. `eval eval eval ... rm -rf /`)
  // would otherwise re-parse the tail at every level (O(n^2) time, O(n) stack) and
  // eventually throw. Fail closed rather than freeze or crash the permission gate.
  if (depth > MAX_RECURSION_DEPTH) {
    return { level: 'high', reasons: ['command nests too deeply to analyze (fail closed)'] };
  }

  const trimmed = command.trim();
  if (trimmed.length === 0) return { level: 'low', reasons: [] };

  if (trimmed.length > MAX_COMMAND_LENGTH) {
    return { level: 'high', reasons: ['command too long to analyze (fail closed)'] };
  }

  if (looksLikeForkBomb(trimmed)) {
    return { level: 'high', reasons: ['fork bomb pattern'] };
  }

  let tokens: ShellToken[];
  try {
    tokens = shellParse(trimmed);
  } catch {
    return { level: 'high', reasons: ['command could not be parsed (fail closed)'] };
  }

  if (tokens.length === 0) {
    // Parsed to nothing (e.g. only a comment): nothing executes.
    return { level: 'low', reasons: [] };
  }

  const reasons: string[] = [];
  let level: CommandRiskLevel = 'low';

  // Split into simple-command segments on control operators, recording each
  // segment's leading program and the operator that follows it (so a fetcher and
  // an interpreter can be checked for membership in the SAME pipeline).
  const segmentProgs: string[] = [];
  const joinerAfter: string[] = [];
  let current: string[] = [];
  let currentHerestrings: string[] = [];
  let pendingHerestring = false;

  const flushSegment = (joiner: string) => {
    if (current.length > 0) {
      const localReasons: string[] = [];
      let segmentLevel = classifySimpleCommand(current, localReasons, depth);
      const lead = leadingProgram(current);
      // `<interp> <<< "code"` (herestring) feeds the string to an interpreter as a
      // script. shell-quote emits `<<<` as a non-segmenting operator so the code never
      // reaches the `-c` recursion; recurse it here when the sink can execute it.
      if (currentHerestrings.length > 0 && (INTERPRETERS.has(lead) || SOURCE_BUILTINS.has(lead))) {
        for (const code of currentHerestrings) {
          localReasons.push(`inline code executed via '${lead} <<<'`);
          const nested = classifyAtDepth(code, depth + 1);
          localReasons.push(...nested.reasons);
          segmentLevel = maxLevel(segmentLevel, nested.level);
        }
      }
      level = maxLevel(level, segmentLevel);
      reasons.push(...localReasons);
      segmentProgs.push(lead);
      joinerAfter.push(joiner);
    }
    current = [];
    currentHerestrings = [];
    pendingHerestring = false;
  };

  for (const token of tokens) {
    if (isOperator(token)) {
      const op = token.op;
      if (op === '<<<') {
        // The next string token is the herestring body, not a command argument.
        pendingHerestring = true;
        continue;
      }
      if (SEGMENT_OPERATORS.has(op)) {
        flushSegment(op);
        continue;
      }
      // Non-segmenting operators (redirections, subshell parens) don't start a new
      // simple command. Block-device redirection targets are checked separately.
      continue;
    }
    const str = asString(token);
    if (str !== null) {
      if (pendingHerestring) {
        currentHerestrings.push(str);
        pendingHerestring = false;
      } else {
        current.push(str);
      }
    }
  }
  flushSegment('');

  // Fetch-and-execute: a network fetcher and an execute-sink within one group, whether
  // piped (`curl x | sh`, `curl | tee | sh`) or process-substituted (`bash <(curl x)`).
  if (isFetchAndExecute(segmentProgs, joinerAfter)) {
    reasons.push('fetch-and-execute: downloaded content executed by an interpreter');
    level = maxLevel(level, 'high');
  }

  // Redirection to a raw block device anywhere in the command.
  if (writesToBlockDevice(tokens)) {
    reasons.push('write redirected to a raw block device');
    level = maxLevel(level, 'high');
  }

  return { level, reasons };
}

/**
 * Joiners that keep a fetcher and its consumer in the same fetch-and-execute group:
 * a pipe (`curl x | sh`) or entering a process substitution (`bash <(curl x)`, where
 * the outer interpreter executes the fetched content). The closing `)` and control
 * operators (`;`, `&&`, `||`, `&`) end the group so unrelated later commands aren't merged.
 */
const FETCH_EXEC_CONNECTORS = new Set(['|', '|&', '<(', '>(']);

/**
 * True if a network fetcher and an execute-sink (interpreter or `source`/`.`) appear
 * within the same fetch-and-execute group - a maximal run of segments connected by a
 * pipe or a process-substitution boundary.
 */
function isFetchAndExecute(progs: string[], joinerAfter: string[]): boolean {
  let start = 0;
  while (start < progs.length) {
    let end = start;
    while (end < progs.length - 1 && FETCH_EXEC_CONNECTORS.has(joinerAfter[end])) {
      end += 1;
    }
    const pipeline = progs.slice(start, end + 1);
    const hasFetcher = pipeline.some(prog => NETWORK_FETCHERS.has(prog));
    const hasSink = pipeline.some(prog => FETCH_SINK_PROGRAMS.has(prog));
    if (hasFetcher && hasSink) return true;
    start = end + 1;
  }
  return false;
}

/** The program name of a simple command after skipping wrappers/privilege escalation. */
function leadingProgram(args: string[]): string {
  const index = skipToInnerProgram(args);
  return index < args.length ? programName(args[index]) : '';
}

/**
 * True if any `>`/`>>` redirection targets a raw block device. Covers the common
 * host shapes: SCSI/SATA (`sd[a-z]`), NVMe, Xen (`xvd[a-z]`, default on many EC2
 * AMIs), virtio (`vd[a-z]`), legacy IDE (`hd[a-z]`), device-mapper/LVM (`dm-N`,
 * `mapper/`), software RAID (`md N`), eMMC/SD (`mmcblkN`), loop, and macOS `diskN`.
 */
const BLOCK_DEVICE_RE =
  /^\/dev\/(sd[a-z]|nvme\d+n\d+|xvd[a-z]|vd[a-z]|hd[a-z]|dm-\d+|md\d+|mmcblk\d+|loop\d+|disk\d+|mapper\/)/;

function writesToBlockDevice(tokens: ShellToken[]): boolean {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (isOperator(token) && (token.op === '>' || token.op === '>>')) {
      let targetIndex = i + 1;
      // bash force-clobber `>|` tokenizes as `>` then `|`; step over the `|` to
      // reach the redirect target, which would otherwise be read as the operator.
      const following = tokens[targetIndex];
      if (isOperator(following) && following.op === '|') targetIndex += 1;
      const target = asString(tokens[targetIndex]);
      if (target && BLOCK_DEVICE_RE.test(target)) {
        return true;
      }
    }
  }
  return false;
}

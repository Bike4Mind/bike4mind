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
]);

/** Privilege-escalation programs: elevated on their own, transparent to the inner program. */
const PRIVILEGE_ESCALATION = new Set(['sudo', 'doas', 'su', 'runuser', 'pkexec']);

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
  // su/runuser: -c (command) is handled by the early escalator recursion; -s takes a shell.
  su: new Set(['-s', '--shell', '-g', '--group', '-G', '--supp-group']),
  runuser: new Set(['-s', '--shell', '-g', '--group', '-G', '--supp-group']),
  pkexec: new Set(['--user']),
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

/** Wrappers that take one bare positional argument before the command (e.g. `timeout 5 <cmd>`). */
const WRAPPERS_WITH_POSITIONAL = new Set(['timeout']);

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
 * Extract the command string carried by `env`'s `-S`/`--split-string` flag, or
 * `null` if `env` does not appear with a split-string flag. Handles separate value
 * (`-S CMD`), combined long form (`--split-string=CMD`), and combined short form
 * (`-SCMD`). Scans env's own flags, consuming the values of its other value flags
 * (`-u FOO`, `-C dir`) so the split-string flag is still found after them.
 */
function envSplitStringValue(args: string[]): string | null {
  const envIndex = args.findIndex(arg => programName(arg) === 'env');
  if (envIndex === -1) return null;
  const envValueFlags = PROGRAM_VALUE_FLAGS.env;
  for (let i = envIndex + 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-S' || arg === '--split-string') {
      return i + 1 < args.length ? args[i + 1] : null;
    }
    if (arg.startsWith('--split-string=')) return arg.slice('--split-string='.length);
    if (arg.startsWith('-S') && !arg.startsWith('--') && arg.length > 2) return arg.slice(2);
    if (!arg.startsWith('-')) return null; // reached the inner program with no split-string flag
    if (envValueFlags.has(arg)) i += 1; // this flag consumes the next token as its value
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
function classifySimpleCommand(args: string[], reasons: string[]): CommandRiskLevel {
  let level: CommandRiskLevel = 'low';

  // `su`/`runuser` carry their target command via `-c "<cmd>"`. Recurse into that
  // string BEFORE the generic wrapper-skip, which would otherwise consume `-c` and
  // its value as a flag pair and hide the real command.
  const escalatorIndex = args.findIndex(arg => ESCALATORS_WITH_COMMAND_FLAG.has(programName(arg)));
  if (escalatorIndex !== -1) {
    const code = commandFlagValue(args, escalatorIndex);
    if (code !== null) {
      reasons.push(`privilege escalation via '${programName(args[escalatorIndex])}'`);
      const nested = classifyCommandRisk(code);
      reasons.push(...nested.reasons);
      return maxLevel('medium', nested.level);
    }
  }

  // `env -S "<cmd>"` (split-string) parses its argument as a full argv and runs it -
  // functionally an interpreter's `-c`. `-S`/`--split-string` is a value flag on env,
  // so the generic wrapper-skip would consume the command string as a flag value and
  // leave `inner` empty (classified `low`). Recurse into the string first.
  const splitString = envSplitStringValue(args);
  if (splitString !== null) {
    reasons.push("split-string execution via 'env -S'");
    const nested = classifyCommandRisk(splitString);
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
    // eval-style ones. Decompose short-flag bundles so `bash -ec "..."`,
    // `sh -exc "..."`, `perl -we '...'` are caught the same way rm/chmod bundles
    // are - whole-string equality (`arg === '-c'`) misses every bundled form.
    const codeFlagLetters = EVAL_E_INTERPRETERS.has(prog) ? /[ce]/ : /c/;
    const codeFlagIndex = inner.findIndex(
      (arg, i) => i > 0 && (arg === '--command' || shortFlagContains(arg, codeFlagLetters))
    );
    if (codeFlagIndex !== -1 && codeFlagIndex + 1 < inner.length) {
      reasons.push(`inline code executed via '${prog} ${inner[codeFlagIndex]}'`);
      const nested = classifyCommandRisk(inner[codeFlagIndex + 1]);
      reasons.push(...nested.reasons);
      return maxLevel(level, nested.level);
    }
  }

  // `eval <string...>`: the remaining arguments form a command string.
  if (prog === 'eval' && inner.length > 1) {
    reasons.push("dynamic evaluation via 'eval'");
    const nested = classifyCommandRisk(inner.slice(1).join(' '));
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
 * Classify the risk of a shell command string.
 *
 * Pure and synchronous. Never throws: a command that cannot be tokenized is
 * treated as `high` (fail closed).
 */
export function classifyCommandRisk(command: string): CommandRiskAssessment {
  const trimmed = command.trim();
  if (trimmed.length === 0) return { level: 'low', reasons: [] };

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

  const flushSegment = (joiner: string) => {
    if (current.length > 0) {
      const localReasons: string[] = [];
      level = maxLevel(level, classifySimpleCommand(current, localReasons));
      reasons.push(...localReasons);
      segmentProgs.push(leadingProgram(current));
      joinerAfter.push(joiner);
    }
    current = [];
  };

  for (const token of tokens) {
    if (isOperator(token)) {
      const op = token.op;
      if (SEGMENT_OPERATORS.has(op)) {
        flushSegment(op);
        continue;
      }
      // Non-segmenting operators (redirections, subshell parens) don't start a new
      // simple command. Block-device redirection targets are checked separately.
      continue;
    }
    const str = asString(token);
    if (str !== null) current.push(str);
  }
  flushSegment('');

  // Fetch-and-execute: a network fetcher and an interpreter within one pipeline
  // (a maximal run of pipe-connected segments), e.g. `curl x | sh` or `curl | tee | sh`.
  if (isFetchAndExecute(segmentProgs, joinerAfter)) {
    reasons.push('fetch-and-execute: downloaded content piped into an interpreter');
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
 * True if a network fetcher and an interpreter appear within the same pipeline -
 * a maximal run of segments connected by `|`/`|&`. Segments separated by `;`,
 * `&&`, `||`, or `&` belong to different pipelines and are not combined.
 */
function isFetchAndExecute(progs: string[], joinerAfter: string[]): boolean {
  let start = 0;
  while (start < progs.length) {
    let end = start;
    while (end < progs.length - 1 && (joinerAfter[end] === '|' || joinerAfter[end] === '|&')) {
      end += 1;
    }
    const pipeline = progs.slice(start, end + 1);
    const hasFetcher = pipeline.some(prog => NETWORK_FETCHERS.has(prog));
    const hasInterpreter = pipeline.some(prog => INTERPRETERS.has(prog));
    if (hasFetcher && hasInterpreter) return true;
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

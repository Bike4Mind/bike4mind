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
 * itself) as well as the consequents, and every one of them is scoped to the step it is about.
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
type ShellCommand = { words: string[]; sep: string };

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
    if (words.length) commands.push({ words, sep });
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

/** Shell keywords and `VAR=value` prefixes, which sit in front of the program rather than being it. */
const SHELL_PREFIX =
  /^(if|then|elif|else|fi|for|while|until|do|done|case|esac|in|!|time|command|env|local|return|exit)$/;

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

const unquoteWord = (word: string) => word.replace(/(^|[^\\])['"]/g, '$1');

/**
 * A reference into a directory the agent can write: `./x`, `../x`, `dir/file`,
 * `$GITHUB_WORKSPACE` or `$RUNNER_TEMP`. Both of those are named because a bare write-tool
 * grant reaches absolute paths, so the runner temp is as writable as the checkout is.
 */
const referencesCheckout = (text: string) =>
  /(?:^|[\s"'=(:])(?:\.{1,2}\/|[A-Za-z0-9_.@-]+\/[A-Za-z0-9_.@/-])/.test(` ${text}`) ||
  /GITHUB_WORKSPACE|RUNNER_TEMP/.test(text);

/** A command's words with its leading `VAR=value` and shell-keyword prefixes dropped. */
function commandProgram(words: string[]): string[] {
  let rest = words;
  while (rest.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]) || SHELL_PREFIX.test(rest[0]))) rest = rest.slice(1);
  return rest;
}

/** The subcommand of a `git` invocation, with git's own global options (and their values) skipped. */
function gitSubcommand(words: string[]): string | undefined {
  const takesValue = /^(-c|-C|--namespace|--git-dir|--work-tree|--exec-path)$/;
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
function gitCommands(src: string, subcommands: RegExp): string[][] {
  const found: string[][] = [];
  for (const body of runBodies(src)) {
    for (const { words } of shellCommands(body)) {
      const rest = commandProgram(words);
      if (unquoteWord(rest[0] ?? '') !== 'git') continue;
      const sub = gitSubcommand(rest);
      if (sub && subcommands.test(sub)) found.push(rest);
    }
  }
  return found;
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
 * True when a command emits bytes the agent can write.
 *
 * `git show HEAD:<path>` reads the object store, which no write tool reaches, and that is the
 * whole reason the transcript redactor is piped from it rather than run from the tree. Every
 * OTHER git subcommand emits metadata (paths, counts, status) rather than file content, so it
 * cannot carry a payload either. Any other program naming a checkout path is reading the
 * working tree, which the agent holds `Edit` on in fold mode.
 */
function readsWritableBytes(words: string[]): boolean {
  const plain = commandProgram(words).map(unquoteWord);
  if (plain[0] === 'git') {
    const sub = gitSubcommand(plain);
    if (sub !== 'show' && sub !== 'cat-file') return false;
    return !plain.slice(1).every(arg => arg.startsWith('-') || arg === sub || arg.startsWith('HEAD:'));
  }
  return plain.some(arg => referencesCheckout(arg));
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
      while (rest.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]) || SHELL_PREFIX.test(rest[0]))) {
        const assignment = rest[0].match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (assignment && referencesCheckout(unquoteWord(assignment[2]))) tainted.add(assignment[1]);
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

/** The keys of a step's `with:` mapping, in file order. */
function withKeys(src: string, name: string): string[] {
  const block = step(src, name).match(/^ {8}with:\n((?: {10}.*\n|\n)+)/m)?.[1];
  expect(block, `${name}: no with: block`).toBeTruthy();
  return [...(block ?? '').matchAll(/^ {10}([a-z_]+):/gm)].map(m => m[1]);
}

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
  const block = step(src, 'Run /bot-review').match(/^ {10}claude_args: \|\n((?: {12}.*\n|\n)+)/m)?.[1];
  expect(block, 'no claude_args block').toBeTruthy();
  const text = withoutComments(block ?? '').replace(/\$\{\{[\s\S]*?\}\}/g, expansion);
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
  const block = step(src, name).match(/^ {8}if: \|\n((?: {10}.*\n)+)/m)?.[1];
  expect(block, `${name}: no block-scalar if:`).toBeTruthy();
  return (block ?? '')
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
  const region = commands.match(/^ {10}BLOCKED=\$\([\s\S]*?-gt 800 \]; then\n[\s\S]*?^ {10}fi$/m)?.[0];
  expect(region, 'could not lift the staged-path guard and size bound out of the push step').toBeTruthy();

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
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: fakeHome };
    // Or git reads $XDG_CONFIG_HOME/git/attributes from the DEVELOPER's home instead.
    delete env.XDG_CONFIG_HOME;
    const run = spawnSync('bash', ['-c', script], { cwd: dir, encoding: 'utf8', env });
    return { status: run.status ?? -1, out: `${run.stdout}${run.stderr}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

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
function runPostedCheck(
  src: string,
  fixture: { since?: string; reviews?: number; inline?: number; issue?: number; apiStatus?: number }
): string {
  // Verbatim, comments included, for the reason `runStagedGuards` states.
  const body = runBodiesRaw(step(src, 'Verify a review was actually posted'))[0];
  expect(body, 'could not lift the posted measurement out of its step').toBeTruthy();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-fold-posted-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    // argv is `api --paginate <path> --jq <selector>`, so $3 is the endpoint.
    fs.writeFileSync(
      path.join(bin, 'gh'),
      [
        '#!/bin/sh',
        'if [ "$FAKE_GH_STATUS" -ne 0 ]; then echo "api error" >&2; exit "$FAKE_GH_STATUS"; fi',
        'case "$3" in',
        '  */pulls/*/reviews) n=$FAKE_REVIEWS ;;',
        '  */pulls/*/comments) n=$FAKE_INLINE ;;',
        '  */issues/*/comments) n=$FAKE_ISSUE ;;',
        '  *) n=0 ;;',
        'esac',
        'i=0; while [ "$i" -lt "$n" ]; do echo "id$i"; i=$((i + 1)); done',
      ].join('\n'),
      { mode: 0o755 }
    );
    const outputs = path.join(dir, 'outputs');
    fs.writeFileSync(outputs, '');
    const run = spawnSync('bash', ['-c', body ?? ''], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
        GITHUB_OUTPUT: outputs,
        GH_TOKEN: 'stub',
        BOT_REVIEW_LOGIN: 'claude[bot]',
        REPO: 'owner/repo',
        PR: '1',
        SINCE: fixture.since ?? '2026-01-01T00:00:00Z',
        FAKE_REVIEWS: String(fixture.reviews ?? 0),
        FAKE_INLINE: String(fixture.inline ?? 0),
        FAKE_ISSUE: String(fixture.issue ?? 0),
        FAKE_GH_STATUS: String(fixture.apiStatus ?? 0),
      },
    });
    const written = fs.readFileSync(outputs, 'utf8');
    const posted = written.match(/^posted=(\S*)$/m)?.[1];
    expect(posted, `no posted= emitted (${run.stdout}${run.stderr})`).toBeTruthy();
    return posted ?? '';
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('bot-fold write path', () => {
  const src = fs.readFileSync(WORKFLOW, 'utf8');

  it('derives FOLD_MODE from the bot-fold label and nothing else', () => {
    // The antecedent every other assertion here is written in terms of. Hardcoding this to
    // 'true' - the obvious way to try to exercise a path that cannot otherwise be rehearsed -
    // gives every `bot-review` label the write tools, a write token and a push to the PR head.
    expect(src).toMatch(/^ {6}FOLD_MODE: \$\{\{ github\.event\.label\.name == 'bot-fold' \}\}$/m);
    expect(src.match(/^ *FOLD_MODE:/gm)).toHaveLength(1);
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
    // Spelling first, because getting it wrong is silent. `Write(path)` and
    // `MultiEdit(path)` specs are IGNORED by the file-permission checks - the CLI says
    // so on stderr and exits 0 - while an `Edit(path)` rule covers every file-editing
    // tool. A previous revision carried all three spellings for both roots, which read
    // as six controls and was two, and is how the $RUNNER_TEMP hole below got missed.
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
        'Edit(/${{ runner.temp }}/**)',
        // git honours an UNTRACKED `.gitattributes`, which `git add -u` never stages and the
        // path guard therefore never sees - and it decides what `--numstat` calls binary, so
        // one planted file turns the binary arm and the 800-line bound off together.
        'Edit(.gitattributes)',
        'Edit(**/.gitattributes)',
      ].sort()
    );
    // Every OTHER parenthesised spec, by value, in BOTH arms. `toContain` on the three
    // `Read()` fences left a bucket nothing read: a spec containing `(` that does not start
    // `Edit(` was asserted by neither the set above nor this, so appending one to either arm
    // was invisible - and appending `Read(/dev/null)" --settings ./ci-settings.json "` put
    // `--settings` on the real CLI's argv while reading as one more hardening deny.
    const reads = ['Read(.git/**)', 'Read(//proc/**)', 'Read(//sys/**)'];
    expect(pathSpecs.filter(spec => !spec.startsWith('Edit(')).sort()).toEqual([...reads].sort());
    // The step's own comment says both branches are spelled out in full by design, so every
    // edit here is a both-arms edit, and a fold-arm-only assertion waves the review arm through.
    expect(deny.review.filter(spec => spec.includes('(')).sort()).toEqual(
      [...reads, 'Edit(/${{ runner.temp }}/**)'].sort()
    );
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
    for (const body of shouldBeCaught) {
      const injected = src.replace(/^ {10}git add -u$/m, `          git add -u\n          ${body}`);
      expect(injected, 'the injection anchor moved').not.toBe(src);
      expect(checkoutCodeReferences(injected), `not caught inside an existing body: ${body}`).not.toEqual([]);
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
    const pythonInvocations = (
      runBodies(src)
        .join('\n')
        .match(/python3[^\n]*/g) ?? []
    ).map(text => text.replace(/;.*$/, '').trim());
    expect(pythonInvocations).toEqual(['python3 -I - "$EXECUTION_FILE" "$SKILL_FILE" "$DEST"']);
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
    expect(runPostedCheck(src, { reviews: 1 })).toBe('true');
    expect(runPostedCheck(src, { inline: 3 })).toBe('true');
    expect(runPostedCheck(src, { issue: 1 })).toBe('true');
    // No watermark means no way to tell this run's review from an older one: not posted.
    expect(runPostedCheck(src, { since: '', reviews: 5 })).toBe('false');
    // An API failure must not read as a review. This is the arm that turns a transient
    // outage into a push on a run that reviewed nothing.
    expect(runPostedCheck(src, { apiStatus: 1, reviews: 5 })).toBe('false');
    // And the measurement has to happen on the runs that need measuring - a step-level
    // gate that skips it leaves `posted` empty, which the consumers read as not-posted,
    // but one that WIDENS it lets a size-guard-skipped run be measured as reviewed.
    expect(ifLine(src, 'Verify a review was actually posted')).toBe(
      "always() && (steps.bot_review.outcome == 'success' || steps.bot_review.outcome == 'failure')"
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
    for (const name of ['Push fold commit', 'Redact and upload review transcript']) {
      const stepSrc = step(src, name);
      expect(stepSrc, `${name}: no GIT_CONFIG_GLOBAL`).toMatch(/^ {10}GIT_CONFIG_GLOBAL: \/dev\/null$/m);
      expect(stepSrc, `${name}: no GIT_CONFIG_SYSTEM`).toMatch(/^ {10}GIT_CONFIG_SYSTEM: \/dev\/null$/m);
      expect(stepSrc, `${name}: no GIT_CONFIG_NOSYSTEM`).toMatch(/^ {10}GIT_CONFIG_NOSYSTEM: '1'$/m);
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
    // The step must fail rather than fall through: without `-e` a failed `git commit`
    // reaches `git push`, which says "Everything up-to-date" and exits 0, so the step
    // emits pushed=true under a green check with nothing on the branch.
    expect(commands).toMatch(/^ {10}set -euo pipefail$/m);
    // And both bounds run before the commit, not after it.
    expect(commands.indexOf('BLOCKED=')).toBeLessThan(commands.indexOf('git -c user.name'));
    expect(commands.indexOf('CHANGED=')).toBeLessThan(commands.indexOf('git -c user.name'));
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
    // command to the shell and a different string to a matcher.
    const spellings = [
      'git push --force "https://x-access-token:${PUSH_TOKEN}@github.com/${REPO}.git" HEAD:refs/heads/main',
      'git -c http.version=HTTP/1.1 push --force origin HEAD:main',
      'git  push --force origin HEAD:main',
      'git \\\n            push --force origin HEAD:main',
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

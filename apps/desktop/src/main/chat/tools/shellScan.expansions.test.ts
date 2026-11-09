import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { globMatches, scanShell } from './shellScan';
import { shellApproval } from './shellTools';

describe('shell expansions reaching a protected location', () => {
  let base: string;
  let project: string;
  let protectedFolder: string;

  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'b4m-shell-expansions-')));
    project = join(base, 'project');
    protectedFolder = join(base, 'protected');
    await mkdir(join(project, 'safe'), { recursive: true });
    await mkdir(protectedFolder);
    await writeFile(join(project, 'safe', 'value'), 'value');
    await writeFile(join(protectedFolder, 'value'), 'value');
    await symlink(protectedFolder, join(project, 'link'));
    for (const name of ['-01', '-02', '000', '001', '002', '-2', '-1', '0', '1', '2']) {
      await symlink(protectedFolder, join(project, 'safe', name));
    }
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const expectAsks = async (command: string): Promise<void> => {
    const approval = await shellApproval(
      'bash_execute',
      { command, cwd: project },
      {
        roots: [project],
        workingDirectory: project,
        signal: new AbortController().signal,
        protectedPaths: [protectedFolder],
        uncoverablePaths: [protectedFolder],
      }
    );
    expect(approval.askInAuto).toBe(true);
    expect(approval.askInFull).toBe(true);
  };

  it.each([
    'li?k',
    'li[an]k',
    'li[!0-9]k',
    'li[![:digit:]]k',
    'li[^[:digit:]]k',
    'li[[:alpha:]]k',
    'li[[.n.]]k',
    'li[[=n=]]k',
    'li[![.x.]]k',
    '{safe,../protected}',
    '{../protected,safe}',
    '{safe,{safe,../protected}}',
    './safe/{-1..-2}',
    './safe/{-2..1}',
    './safe/{2..0}',
  ])('asks in every mode before reading or writing %s', async operand => {
    for (const command of [`cat ${operand}/value`, `cp safe/value ${operand}/value`]) {
      const scan = await scanShell(command, project, [project]);
      expect(scan?.paths).toContain(join(protectedFolder, 'value'));
      await expectAsks(command);
    }
  });

  it.each([
    // bash 3.2 (macOS) drops the padding and leaves a step as written, where 5.x reads `-01` and `-02`.
    './safe/{-01..-02}',
    './safe/{-02..-01}',
    './safe/{-01..002}',
    './safe/{-2..1..1}',
    // bash pairs the `{` with the `}` after the comma: `x}a/value` and `../protected/value`.
    '{x}a,../protected}',
  ])('asks in every mode, reading nothing, before reading or writing %s', async operand => {
    for (const command of [`cat ${operand}/value`, `cp safe/value ${operand}/value`]) {
      expect((await scanShell(command, project, [project]))?.unread).toBe(true);
      await expectAsks(command);
    }
  });

  it.each([
    ['{-1..-2}', ['-1', '-2']],
    ['{-2..1}', ['-2', '-1', '0', '1']],
    ['{1..-1}', ['1', '0', '-1']],
    ['{-0..1}', ['0', '1']],
    ['{3..3}', ['3']],
    ['{a..c}', ['a', 'b', 'c']],
    ['{c..a}', ['c', 'b', 'a']],
    ['{2147483646..2147483647}', ['2147483646', '2147483647']],
    ['{-2147483647..-2147483648}', ['-2147483647', '-2147483648']],
    ['{x,{1..2}}', ['x', '1', '2']],
    ['{1..2}{a,b}', ['1a', '1b', '2a', '2b']],
    ['{a..b,c}', ['a..b', 'c']],
    ['{x}{a,b}', ['{x}a', '{x}b']],
    ['{x{a,b}}', ['{xa}', '{xb}']],
    ['{}', ['{}']],
  ] as const)('records every path in %s as each bash expands it', async (range, expected) => {
    const scan = await scanShell(`cat range/${range}/value`, project, [project]);
    expect(scan?.paths?.filter(path => path.startsWith(join(project, 'range')))).toEqual(
      expected.map(name => join(project, 'range', name, 'value'))
    );
    // The host's bash: 5.x on Linux, 3.2 as macOS `/bin/bash`.
    const printed = execFileSync('bash', ['-c', `printf '%s\\n' ${range}`], { encoding: 'utf8' });
    expect(printed.split('\n').slice(0, -1)).toEqual(expected);
  });

  it.each([
    // Past 32 bits, which bash 3.2 truncates.
    '{2147483647..2147483648}',
    '{-2147483649..-2147483648}',
    '{9007199254740992..9007199254740993}',
    // Zero padding, which bash 3.2 drops.
    '{01..3}',
    '{1..03}',
    '{-01..2}',
    '{00..-0}',
    // A step, which bash 3.2 leaves as written.
    '{1..3..1}',
    '{2..-2..2}',
    '{a..e..2}',
    '{-9007199254740991..9007199254740991..9007199254740991}',
    // A sign, or a `..` that makes no plain sequence, which bash versions skip or keep differently.
    '{+1..3}',
    '{1..+3}',
    '{1..x}',
    '{1..{2,3}}',
    '{a..}',
    '{1..3.}',
    // More words than the scan reads.
    '{1..100}',
    // Braces that do not balance around a comma, where bash pairs the `{` with the `}` after it.
    '{x}a,b}',
    '{a,b}c}',
    '}{a,b}',
    '{{a,b}',
  ])('leaves %s unread', async range => {
    expect((await scanShell(`cat range/${range}/value`, project, [project]))?.unread).toBe(true);
  });

  it.each([
    // Within double quotes brace expansion opens no quote at a backtick or `${`, so the inner `"` ends the quote.
    'echo "`echo "{a,b}"`"',
    'echo "`echo ".x{a..b}"`"',
    'echo "${x:-"{a,b}"}"',
    'echo "${x#"{a,b}"}"',
    'echo "${x:-"}"}"{a,b}',
    'echo a"$(echo ")")"{a,b}',
    // bash 3.2 skips no `$(` within double quotes.
    'echo "$(echo "{a,b}")"',
    'echo "$(echo "a" "{a,b}")"',
    'for f in "`echo "{a,b}"`"; do :; done',
    'a=("`echo "{a,b}"`")',
    'export x="`echo "{a,b}"`"',
    'cat < "`echo "{a,b}"`"',
  ])('leaves %s unread, as bash brace-expands a word the scan reads as quoted', async command => {
    expect((await scanShell(command, project, [project]))?.unread).toBe(true);
  });

  it.each([
    'echo {a,b}',
    'echo "{a,b}"',
    'echo "`echo {a,b}`"',
    'echo `echo "{a,b}"`',
    'echo $(echo "{a,b}")',
    "echo \"$(printf '%s' '{x, y}')\"",
    'echo "$(cat <<\'EOF\'\nfix: {a, b} and "c"\nEOF\n)"',
    'echo ${HOME}/{a,b}',
    'echo "${x//,/ }"',
    'echo ${x:-{a,b}}',
    'cat <(echo {a,b})',
    'x="`echo "{a,b}"`"',
  ])('reads %s as each bash brace-expands it', async command => {
    expect((await scanShell(command, project, [project]))?.unread).toBeUndefined();
  });

  it.each([
    ['"`printf %s "{a,b}"`"', ['a', 'b']],
    ['"${x:-"{a,b}"}"', ['a', 'b']],
    ['"${x:-"}"}"{a,b}', ['}a', '}b']],
    ['a"$(printf %s ")")"{a,b}', ['a)a', 'a)b']],
  ] as const)('expands %s in host bash as the scan expects', (word, expected) => {
    // Whichever bash is first in PATH; each of these expands the same in 3.2 and 5.
    const printed = execFileSync('bash', ['-c', `printf '%s\\n' ${word}`], { encoding: 'utf8' });
    expect(printed.split('\n').slice(0, -1)).toEqual(expected);
  });
});

describe('conservative POSIX bracket matching', () => {
  const component = (pattern: string) => [...pattern].map(char => ({ char, glob: '*?['.includes(char), active: true }));

  it.each(['[[:alpha:]]', '[![:alpha:]]', '[^[:digit:]]', '[[.n.]]', '[[=n=]]', '[![.x.]]', '[^[=x=]]'])(
    'keeps %s conservative with and without negation',
    pattern => {
      expect(globMatches(component(`li${pattern}k`), 'link', false)).toBe(true);
    }
  );

  it.each([
    ['li[!0-9]k', 'link', true],
    ['li[!0-9]k', 'li5k', false],
    ['li[an]k', 'link', true],
    ['li[a-z]k', 'link', true],
    ['li[an]k', 'lixk', false],
    ['li[', 'li[', true],
  ] as const)('preserves %s against %s', (pattern, name, expected) => {
    expect(globMatches(component(pattern), name, false)).toBe(expected);
  });
});

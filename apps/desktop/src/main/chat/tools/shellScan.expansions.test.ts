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
    for (const name of ['-01', '-02', '000', '001', '002']) {
      await symlink(protectedFolder, join(project, 'safe', name));
    }
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

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
    './safe/{-01..-02}',
    './safe/{-02..-01}',
    './safe/{-01..002}',
  ])('asks in every mode before reading or writing %s', async operand => {
    for (const command of [`cat ${operand}/value`, `cp safe/value ${operand}/value`]) {
      const scan = await scanShell(command, project, [project]);
      expect(scan?.paths).toContain(join(protectedFolder, 'value'));
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
    }
  });

  it.each([
    ['{-01..-02}', ['-01', '-02']],
    ['{-02..-01}', ['-02', '-01']],
    ['{-01..02}', ['-01', '000', '001', '002']],
    ['{01..-2}', ['01', '00', '-1', '-2']],
    ['{-003..-001..2}', ['-003', '-001']],
    ['{00..-0}', ['00']],
    ['{2..-2..2}', ['2', '0', '-2']],
    ['{a..c}', ['a', 'b', 'c']],
  ] as const)('records every path in the signed or stepped range %s', async (range, expected) => {
    const scan = await scanShell(`cat range/${range}/value`, project, [project]);
    expect(scan?.paths?.filter(path => path.startsWith(join(project, 'range')))).toEqual(
      expected.map(name => join(project, 'range', name, 'value'))
    );
  });

  it.each(['{9007199254740992..9007199254740993}', '{-9007199254740991..9007199254740991..9007199254740991}'])(
    'leaves the numeric range %s outside exact arithmetic unread',
    async range => {
      expect((await scanShell(`cat range/${range}/value`, project, [project]))?.unread).toBe(true);
    }
  );
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

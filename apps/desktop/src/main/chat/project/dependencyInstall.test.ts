import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundProcessInfo } from '@shared/chat';
import { DependencyInstaller, planInstall } from './dependencyInstall';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'b4m-deps-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const pkg = (extra: object = {}) => writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x', ...extra }));
const file = (name: string) => writeFile(join(dir, name), '');

describe('planInstall', () => {
  it.each([
    ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
    ['yarn.lock', 'yarn install --frozen-lockfile'],
    ['package-lock.json', 'npm ci'],
    ['bun.lock', 'bun install --frozen-lockfile'],
    ['bun.lockb', 'bun install --frozen-lockfile'],
  ])('picks the manager from %s', async (lockfile, command) => {
    await pkg();
    await file(lockfile);
    expect((await planInstall(dir))?.command).toBe(command);
  });

  it('uses --immutable for a Berry yarn', async () => {
    await pkg();
    await file('yarn.lock');
    await file('.yarnrc.yml');
    expect((await planInstall(dir))?.command).toBe('yarn install --immutable');
  });

  it('lets packageManager override the lockfile', async () => {
    await pkg({ packageManager: 'pnpm@9.1.0' });
    await file('package-lock.json');
    expect((await planInstall(dir))?.command).toBe('pnpm install --frozen-lockfile');
  });

  it('reads Berry from a yarn packageManager version', async () => {
    await pkg({ packageManager: 'yarn@4.1.0' });
    await file('yarn.lock');
    expect((await planInstall(dir))?.command).toBe('yarn install --immutable');
  });

  it('ignores an unrecognised packageManager', async () => {
    await pkg({ packageManager: 'weird@1' });
    await file('package-lock.json');
    expect((await planInstall(dir))?.command).toBe('npm ci');
  });

  it('does nothing without a lockfile', async () => {
    await pkg();
    expect(await planInstall(dir)).toBeNull();
  });

  it('does nothing without a package.json', async () => {
    await file('pnpm-lock.yaml');
    expect(await planInstall(dir)).toBeNull();
  });

  it('does nothing when node_modules exists', async () => {
    await pkg();
    await file('pnpm-lock.yaml');
    await mkdir(join(dir, 'node_modules'));
    expect(await planInstall(dir)).toBeNull();
  });
});

function fakeRegistry(initial: Partial<BackgroundProcessInfo> = {}) {
  const info: BackgroundProcessInfo = {
    id: 'abc12345',
    sessionId: 's1',
    command: 'pnpm install --frozen-lockfile',
    cwd: dir,
    status: 'running',
    startedAt: new Date().toISOString(),
    bufferedChars: 0,
    droppedChars: 0,
    ...initial,
  };
  return {
    info,
    start: vi.fn(async () => ({ ...info })),
    get: vi.fn((_id: string, _sessionId: string) => ({ ...info })),
    tail: vi.fn((_id: string, _sessionId: string, _max: number) => 'ERR_PNPM_BOOM'),
  };
}

describe('DependencyInstaller', () => {
  const setup = async () => {
    await pkg();
    await file('pnpm-lock.yaml');
    const registry = fakeRegistry();
    const installer = new DependencyInstaller(registry);
    return { registry, installer };
  };

  it('registers an install under the session', async () => {
    const { registry, installer } = await setup();
    await installer.maybeStart({ sessionId: 's1', workingDirectory: dir, outcome: 'created' });
    expect(registry.start).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        command: 'pnpm install --frozen-lockfile',
        cwd: dir,
      })
    );
  });

  it('does not install into a reused worktree', async () => {
    const { registry, installer } = await setup();
    await installer.maybeStart({ sessionId: 's1', workingDirectory: dir, outcome: 'reused' });
    expect(registry.start).not.toHaveBeenCalled();
    expect(installer.promptLines('s1')).toEqual([]);
  });

  it('does not install when node_modules exists', async () => {
    const { registry, installer } = await setup();
    await mkdir(join(dir, 'node_modules'));
    await installer.maybeStart({ sessionId: 's1', workingDirectory: dir, outcome: 'created' });
    expect(registry.start).not.toHaveBeenCalled();
  });

  it('says nothing before an install exists', async () => {
    const { installer } = await setup();
    expect(installer.promptLines('s1')).toEqual([]);
  });

  it('tells the model an install is running', async () => {
    const { installer } = await setup();
    await installer.maybeStart({ sessionId: 's1', workingDirectory: dir, outcome: 'created' });
    const text = installer.promptLines('s1').join('\n');
    expect(text).toContain('installing in the background');
    expect(text).toContain('abc12345');
    expect(text).toContain('bash_output');
  });

  it('tells the model it finished, and stops mentioning it later', async () => {
    const { registry, installer } = await setup();
    await installer.maybeStart({ sessionId: 's1', workingDirectory: dir, outcome: 'created' });
    Object.assign(registry.info, { status: 'exited', exitCode: 0, endedAt: new Date().toISOString() });
    expect(installer.promptLines('s1').join('\n')).toContain('finished installing');

    registry.info.endedAt = new Date(Date.now() - 11 * 60_000).toISOString();
    expect(installer.promptLines('s1')).toEqual([]);
  });

  it('reports a failure with the output tail', async () => {
    const { registry, installer } = await setup();
    await installer.maybeStart({ sessionId: 's1', workingDirectory: dir, outcome: 'created' });
    Object.assign(registry.info, { status: 'exited', exitCode: 1, endedAt: new Date().toISOString() });
    const text = installer.promptLines('s1').join('\n');
    expect(text).toContain('failed');
    expect(text).toContain('exited 1');
    expect(text).toContain('ERR_PNPM_BOOM');
  });

  it('is silent for an install the user stopped', async () => {
    const { registry, installer } = await setup();
    await installer.maybeStart({ sessionId: 's1', workingDirectory: dir, outcome: 'created' });
    registry.info.status = 'killed';
    expect(installer.promptLines('s1')).toEqual([]);
  });
});

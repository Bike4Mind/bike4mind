import { execFile } from 'node:child_process';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BackgroundProcessInfo } from '@shared/chat';
import { BackgroundProcessRegistry } from './BackgroundProcessRegistry';

const run = promisify(execFile);

/** True while any process still has `marker` in its argv - how a leaked group is caught. */
async function isAlive(marker: string): Promise<boolean> {
  const { stdout } = await run('/bin/ps', ['-Ao', 'args']).catch(() => ({ stdout: '' }));
  return stdout.split('\n').some(line => line.includes(marker) && !line.includes('ps -Ao') && !line.includes('grep'));
}

async function waitUntilGone(marker: string, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isAlive(marker))) return true;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return false;
}

/**
 * These start REAL processes under the real sandbox and then check with `ps` that they are
 * actually gone. That is the whole point: a mocked spawn would assert we called kill, and the
 * failure this feature exists to prevent is a process group that survives the call.
 */
describe('BackgroundProcessRegistry', () => {
  let root: string;
  let registry: BackgroundProcessRegistry;
  let statuses: BackgroundProcessInfo[];
  let output: string[];

  const start = (command: string, sessionId = 'session-a') =>
    registry.start({ sessionId, command, cwd: root, roots: [root], protectedPaths: [] });

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-bg-')));
    statuses = [];
    output = [];
    registry = new BackgroundProcessRegistry({
      output: (_sessionId, _processId, _stream, text) => output.push(text),
      status: (_sessionId, info) => statuses.push(info),
    });
  });

  afterEach(async () => {
    await registry.shutdown();
    registry.shutdownSync();
  });

  it('returns a handle while the command is still running, and streams its output', async () => {
    const marker = `b4m-marker-${Date.now()}`;
    const info = await start(`echo ${marker}; sleep 20`);

    expect(info.status).toBe('running');
    await registry.settle(info.id, 1_500);

    const read = registry.readForModel(info.id, 'session-a', 5_000);
    expect(read?.text).toContain(marker);
    expect(read?.info.status).toBe('running');
    expect(output.join('')).toContain(marker);
  }, 20_000);

  it('hands the model only new output on a second read', async () => {
    const info = await start('echo one; sleep 0.4; echo two; sleep 20');
    await registry.settle(info.id, 1_500);

    const first = registry.readForModel(info.id, 'session-a', 5_000);
    expect(first?.text).toContain('one');
    expect(first?.text).toContain('two');
    expect(registry.readForModel(info.id, 'session-a', 5_000)?.text).toBe('');
  }, 20_000);

  it('reports a command that dies immediately as finished, not as a live handle', async () => {
    const info = await start('echo starting; exit 7');
    await registry.settle(info.id, 3_000);

    const read = registry.readForModel(info.id, 'session-a', 5_000);
    expect(read?.info.status).toBe('exited');
    expect(read?.info.exitCode).toBe(7);
  }, 20_000);

  /** The reason signals go to -pgid: a bare pid leaves the command's children running. */
  it('kills the whole process group, not just the command it spawned', async () => {
    const marker = `b4m-child-${Date.now()}`;
    const info = await start(`sh -c 'sleep 60 # ${marker}' & sleep 60`);

    await registry.settle(info.id, 1_000);
    expect(await isAlive(marker)).toBe(true);

    await registry.kill(info.id, 'session-a');

    expect(await waitUntilGone(marker)).toBe(true);
    expect(registry.get(info.id, 'session-a')?.status).toBe('killed');
  }, 30_000);

  it('kills everything on shutdown, which is what app quit calls', async () => {
    const marker = `b4m-quit-${Date.now()}`;
    await start(`sleep 60 # ${marker}`);
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(await isAlive(marker)).toBe(true);

    await registry.shutdown();

    expect(await waitUntilGone(marker)).toBe(true);
  }, 30_000);

  it('takes a deleted conversation processes with it', async () => {
    const marker = `b4m-session-${Date.now()}`;
    await start(`sleep 60 # ${marker}`, 'doomed');
    await new Promise(resolve => setTimeout(resolve, 500));

    await registry.killSession('doomed');

    expect(await waitUntilGone(marker)).toBe(true);
    expect(registry.list('doomed')).toHaveLength(0);
  }, 30_000);

  it('will not let one conversation read or stop another process', async () => {
    const info = await start('sleep 20', 'session-a');

    expect(registry.get(info.id, 'session-b')).toBeNull();
    expect(registry.readForModel(info.id, 'session-b', 1_000)).toBeNull();
    await expect(registry.kill(info.id, 'session-b')).resolves.toBeNull();
    expect(registry.get(info.id, 'session-a')?.status).toBe('running');
  }, 20_000);

  it('refuses to accumulate background processes without limit', async () => {
    for (let i = 0; i < 5; i++) await start('sleep 20');
    await expect(start('sleep 20')).rejects.toThrow(/already has 5 background commands/);
  }, 30_000);

  it('announces every status change so the UI can follow without polling', async () => {
    const info = await start('echo done');
    await registry.settle(info.id, 3_000);

    expect(statuses.filter(entry => entry.id === info.id).map(entry => entry.status)).toEqual(['running', 'exited']);
  }, 20_000);
});

import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackgroundProcessRegistry } from './BackgroundProcessRegistry';
import { bashBackground, bashKill, bashList, bashOutput } from './backgroundTools';
import { bashExecute } from './shellTools';
import type { ToolContext } from './types';

describe('background tools', () => {
  let root: string;
  let registry: BackgroundProcessRegistry;
  let context: ToolContext;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-bgtool-')));
    registry = new BackgroundProcessRegistry({ output: () => undefined, status: () => undefined });
    context = {
      roots: [root],
      signal: new AbortController().signal,
      protectedPaths: [],
      sessionId: 'session-a',
      background: registry,
    };
  });

  afterEach(() => registry.shutdown());

  /**
   * Approving a 60-second `npm run dev` must not silently also approve leaving it running all
   * afternoon, so the two tools cannot share a standing-approval key.
   */
  it('keys its approval apart from the foreground tool for the same command', async () => {
    const foreground = await bashExecute.approval?.({ command: 'npm run dev', cwd: root }, context);
    const background = await bashBackground.approval?.({ command: 'npm run dev', cwd: root }, context);

    expect(background?.key).not.toBe(foreground?.key);
    expect(background?.detail).toContain('Keeps running');
  });

  it('refuses the same commands the foreground tool refuses', async () => {
    await expect(bashBackground.run({ command: 'sudo npm run dev' }, context)).rejects.toThrow(/elevated privileges/);
  });

  it('refuses a working directory outside the granted roots', async () => {
    await expect(bashBackground.run({ command: 'sleep 1', cwd: '/etc' }, context)).rejects.toThrow(
      /outside the folders/
    );
  });

  it('starts a process, lists it, reads from it and stops it', async () => {
    const started = await bashBackground.run({ command: 'echo up; sleep 20' }, context);
    expect(started).toContain('up');
    expect(started).toContain('still running');

    const id = /\[([0-9a-f]{8})\]/.exec(started)?.[1];
    expect(id).toBeDefined();

    expect(await bashList.run({}, context)).toContain('1 running');
    expect(await bashOutput.run({ id }, context)).toContain('[no new output]');
    expect(await bashOutput.run({ id, from_start: true }, context)).toContain('up');

    expect(await bashKill.run({ id }, context)).toContain('stopped');
    expect(await bashList.run({}, context)).toContain('0 running');
  }, 30_000);

  it('tells the model plainly when a handle is not one of its own', async () => {
    await expect(bashOutput.run({ id: 'deadbeef' }, context)).rejects.toThrow(/No background process/);
    await expect(bashKill.run({ id: 'deadbeef' }, context)).rejects.toThrow(/No background process/);
  });

  it('refuses to run at all without a conversation to own the process', async () => {
    await expect(bashBackground.run({ command: 'sleep 1' }, { ...context, sessionId: undefined })).rejects.toThrow(
      /conversation/
    );
  });
});

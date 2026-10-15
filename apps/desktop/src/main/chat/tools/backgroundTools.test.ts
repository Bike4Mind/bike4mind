import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackgroundProcessRegistry } from './BackgroundProcessRegistry';
import { bashBackground, bashKill, bashList, bashOutput } from './backgroundTools';
import { ForegroundCommandRegistry } from './ForegroundCommandRegistry';
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

  /**
   * The point of the whole handover from the model's side: the call it is blocked on answers
   * with a handle, and every background tool then works on that handle exactly as it would on
   * one bash_background had returned.
   */
  it('answers the waiting foreground call with a handle its own tools can read', async () => {
    const foreground = new ForegroundCommandRegistry();
    const movable: ToolContext = { ...context, callId: 'call-1', foreground };
    const marker = `b4m-handover-${Date.now()}`;

    const pending = bashExecute.run({ command: `echo ${marker}; sleep 20` }, movable);

    const deadline = Date.now() + 8_000;
    let moved = foreground.moveToBackground('session-a', 'call-1');
    while (!moved.ok && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      moved = foreground.moveToBackground('session-a', 'call-1');
    }
    expect(moved.ok).toBe(true);
    const id = moved.ok ? moved.process.id : '';

    // Resolved, not left hanging until the foreground timeout: that is the bug this replaces.
    const result = await pending;
    expect(result).toContain(`[${id}]`);
    expect(result).toContain('bash_output');

    expect(await bashList.run({}, context)).toContain('1 running');
    expect(await bashOutput.run({ id, from_start: true }, context)).toContain(marker);
    expect(await bashKill.run({ id }, context)).toContain('stopped');
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

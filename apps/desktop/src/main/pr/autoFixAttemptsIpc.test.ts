import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc';
import { AutoFixAttemptsPreference } from './AutoFixAttemptsPreference';
import { registerAutoFixAttemptsIpc } from './autoFixAttemptsIpc';

async function setup(stored?: string) {
  const file = join(await mkdtemp(join(tmpdir(), 'b4m-auto-fix-attempts-')), 'auto-fix-attempts.json');
  if (stored !== undefined) await writeFile(file, stored);
  const apply = vi.fn(async (_attempts: number) => undefined);
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerAutoFixAttemptsIpc(
    {
      handle: (channel: string, listener: (...args: never[]) => unknown) =>
        void handlers.set(channel, listener as never),
    },
    { preference: new AutoFixAttemptsPreference(file), apply }
  );
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({ sender: {} }, ...args);
  return { file, apply, call };
}

describe('registerAutoFixAttemptsIpc', () => {
  it('answers five when nothing is stored', async () => {
    const { call } = await setup();
    expect(await call(IPC_CHANNELS.prGetAutoFixAttempts)).toBe(5);
  });

  it('saves a value in range and hands it to the PR monitor', async () => {
    const { file, apply, call } = await setup();
    expect(await call(IPC_CHANNELS.prSetAutoFixAttempts, 2)).toBe(2);
    expect(apply).toHaveBeenCalledWith(2);
    expect(await call(IPC_CHANNELS.prGetAutoFixAttempts)).toBe(2);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ attempts: 2 });
  });

  it.each([null, '3', 0, 21, 2.5, { attempts: 3 }])('saves garbage from the renderer as five: %j', async input => {
    const { apply, call } = await setup();
    expect(await call(IPC_CHANNELS.prSetAutoFixAttempts, input)).toBe(5);
    expect(apply).toHaveBeenCalledWith(5);
  });

  it.each(['not json', '{"attempts":99}', '{"attempts":"4"}', '7'])('reads a damaged file as five: %s', async raw => {
    const { call } = await setup(raw);
    expect(await call(IPC_CHANNELS.prGetAutoFixAttempts)).toBe(5);
  });

  it('rejects and skips the monitor when the value cannot be saved', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'b4m-auto-fix-attempts-'));
    const blocker = join(dir, 'file');
    await writeFile(blocker, '');
    const apply = vi.fn(async (_attempts: number) => undefined);
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerAutoFixAttemptsIpc(
      {
        handle: (channel: string, listener: (...args: never[]) => unknown) =>
          void handlers.set(channel, listener as never),
      },
      { preference: new AutoFixAttemptsPreference(join(blocker, 'auto-fix-attempts.json')), apply }
    );
    await expect(handlers.get(IPC_CHANNELS.prSetAutoFixAttempts)?.({ sender: {} }, 2)).rejects.toThrow();
    expect(apply).not.toHaveBeenCalled();
    expect(await handlers.get(IPC_CHANNELS.prGetAutoFixAttempts)?.({ sender: {} })).toBe(5);
  });

  it('still answers saved when the monitor fails to apply the value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { apply, call } = await setup();
    apply.mockRejectedValueOnce(new Error('disk full'));
    expect(await call(IPC_CHANNELS.prSetAutoFixAttempts, 8)).toBe(8);
    expect(await call(IPC_CHANNELS.prGetAutoFixAttempts)).toBe(8);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('reads a stored value back after a restart', async () => {
    const { call } = await setup('{"attempts":12}');
    expect(await call(IPC_CHANNELS.prGetAutoFixAttempts)).toBe(12);
  });
});

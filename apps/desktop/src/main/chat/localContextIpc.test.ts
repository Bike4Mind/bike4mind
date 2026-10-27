import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc';
import { LocalContextPreference } from './LocalContextPreference';
import { registerLocalContextIpc } from './localContextIpc';

async function setup() {
  const file = join(await mkdtemp(join(tmpdir(), 'b4m-local-context-ipc-')), 'local-context.json');
  const forget = vi.fn();
  const fit = vi.fn(async () => ({ 262144: ['qwen3:8b'] }));
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerLocalContextIpc(
    {
      handle: (channel: string, listener: (...args: never[]) => unknown) =>
        void handlers.set(channel, listener as never),
    },
    { preference: new LocalContextPreference(file), forget, fit }
  );
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({ sender: {} }, ...args);
  return { file, forget, fit, call };
}

describe('registerLocalContextIpc', () => {
  it('saves a fixed size and makes every model size itself again', async () => {
    const { file, forget, call } = await setup();
    expect(await call(IPC_CHANNELS.chatSetLocalContext, { mode: 'fixed', tokens: 65536 })).toEqual({
      mode: 'fixed',
      tokens: 65536,
    });
    expect(forget).toHaveBeenCalledOnce();
    expect(await call(IPC_CHANNELS.chatGetLocalContext)).toEqual({ mode: 'fixed', tokens: 65536 });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ mode: 'fixed', tokens: 65536 });
  });

  it.each([null, 'fixed', 42, { mode: 'fixed', tokens: 1234 }, { mode: 'fixed', tokens: '65536' }, { mode: 'turbo' }])(
    'reads garbage from the renderer as Auto: %j',
    async input => {
      const { forget, call } = await setup();
      expect(await call(IPC_CHANNELS.chatSetLocalContext, input)).toEqual({ mode: 'auto' });
      expect(await call(IPC_CHANNELS.chatGetLocalContext)).toEqual({ mode: 'auto' });
      expect(forget).toHaveBeenCalledOnce();
    }
  );

  it('answers which sizes may not fit', async () => {
    const { fit, call } = await setup();
    expect(await call(IPC_CHANNELS.chatGetLocalContextFit)).toEqual({ 262144: ['qwen3:8b'] });
    expect(fit).toHaveBeenCalledOnce();
  });
});

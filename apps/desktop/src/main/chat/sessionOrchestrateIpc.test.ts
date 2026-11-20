import type { ChatSessionSummary } from '@shared/chat';
import { IPC_CHANNELS } from '@shared/ipc';
import { describe, expect, it, vi } from 'vitest';
import { registerSessionOrchestrateIpc } from './sessionOrchestrateIpc';

function setup() {
  const summary = { id: 's1', orchestrate: true } as ChatSessionSummary;
  const setSessionOrchestrate = vi.fn(() => Promise.resolve(summary));
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerSessionOrchestrateIpc(
    {
      handle: (channel: string, listener: (...args: never[]) => unknown) =>
        void handlers.set(channel, listener as never),
    },
    { setSessionOrchestrate }
  );
  const call = (...args: unknown[]) => handlers.get(IPC_CHANNELS.chatSetSessionOrchestrate)?.({}, ...args);
  return { summary, setSessionOrchestrate, call };
}

describe('session orchestrate IPC handler', () => {
  it('passes a boolean through to the service', async () => {
    const { summary, setSessionOrchestrate, call } = setup();

    expect(await call('s1', true)).toBe(summary);
    await call('s1', false);

    expect(setSessionOrchestrate.mock.calls).toEqual([
      ['s1', true],
      ['s1', false],
    ]);
  });

  it('answers null and writes nothing for a value that is not a boolean, or an id that is not a string', async () => {
    const { setSessionOrchestrate, call } = setup();

    const answers = await Promise.all([
      call('s1', 'true'),
      call('s1', 1),
      call('s1', undefined),
      call('s1', null),
      call(42, true),
    ]);

    expect(answers).toEqual([null, null, null, null, null]);
    expect(setSessionOrchestrate).not.toHaveBeenCalled();
  });
});

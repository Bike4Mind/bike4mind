import { act, renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claimReplayDispatch, registerUiSideEffectHandler } from '@client/app/utils/uiSideEffectDispatcher';
import { useLatestReplySideEffectReplay } from './useLatestReplySideEffectReplay';

const effects = [{ type: 'plugin-effect', payload: {} }];
const questsWith = (id: string) => [{ id, status: 'done', uiSideEffects: effects }];

let unregister: () => void = () => {};

const handler = vi.fn(() => 1);

const flushRelease = () => act(async () => new Promise(resolve => setTimeout(resolve, 0)));

describe('useLatestReplySideEffectReplay', () => {
  afterEach(() => {
    unregister();
    handler.mockClear();
  });

  const mount = (sessionId: string, quests: ReturnType<typeof questsWith>, strict = false) => {
    unregister = registerUiSideEffectHandler(handler);
    const wrapper = strict ? StrictMode : undefined;
    return renderHook(
      ({ id, qs }: { id: string; qs: ReturnType<typeof questsWith> }) => useLatestReplySideEffectReplay(id, qs),
      {
        initialProps: { id: sessionId, qs: quests },
        wrapper,
      }
    );
  };

  it('replays the newest finished reply once, without the live flag', () => {
    const quests = questsWith('replay-hook-1');
    mount('replay-session-1', quests);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(effects, {});
  });

  it('skips a reply the render path already replayed into this view', () => {
    expect(claimReplayDispatch('replay-hook-2', 'replay-session-2')).toBe(true);
    mount('replay-session-2', questsWith('replay-hook-2'));

    expect(handler).not.toHaveBeenCalled();
  });

  it('replays again after another session and back', async () => {
    const quests = questsWith('replay-hook-3');
    const { rerender } = mount('replay-session-3a', quests);
    expect(handler).toHaveBeenCalledTimes(1);

    rerender({ id: 'replay-session-3b', qs: quests });
    await flushRelease();

    rerender({ id: 'replay-session-3a', qs: quests });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenLastCalledWith(effects, {});
  });

  it('replays once under StrictMode, whose remount must not release the view', async () => {
    const { rerender } = mount('replay-session-4', questsWith('replay-hook-4'), true);
    expect(handler).toHaveBeenCalledTimes(1);

    // A release from the simulated unmount must not land on the live view, or the next
    // refetch (new quests array) would replay the same reply into it again.
    await flushRelease();
    rerender({ id: 'replay-session-4', qs: questsWith('replay-hook-4') });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

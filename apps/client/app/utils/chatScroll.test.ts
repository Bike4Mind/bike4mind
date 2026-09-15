import { describe, it, expect, vi } from 'vitest';
import { registerScrollToMessageHandler, requestScrollToMessage } from './chatScroll';

describe('chatScroll', () => {
  it('returns false when no handler is registered', () => {
    expect(requestScrollToMessage('msg-1')).toBe(false);
  });

  it('routes requests to the registered handler', () => {
    const handler = vi.fn().mockReturnValue(true);
    const unregister = registerScrollToMessageHandler(handler);

    expect(requestScrollToMessage('msg-1')).toBe(true);
    expect(handler).toHaveBeenCalledWith('msg-1');

    unregister();
  });

  it('propagates a not-found result from the handler', () => {
    const unregister = registerScrollToMessageHandler(() => false);

    expect(requestScrollToMessage('missing')).toBe(false);

    unregister();
  });

  it('unregister removes the handler', () => {
    const handler = vi.fn().mockReturnValue(true);
    const unregister = registerScrollToMessageHandler(handler);
    unregister();

    expect(requestScrollToMessage('msg-1')).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('last registration wins and stale unregister is a no-op', () => {
    const first = vi.fn().mockReturnValue(true);
    const second = vi.fn().mockReturnValue(true);
    const unregisterFirst = registerScrollToMessageHandler(first);
    const unregisterSecond = registerScrollToMessageHandler(second);

    // A stale unregister from the replaced handler must not remove the active one
    unregisterFirst();
    expect(requestScrollToMessage('msg-1')).toBe(true);
    expect(second).toHaveBeenCalledWith('msg-1');
    expect(first).not.toHaveBeenCalled();

    unregisterSecond();
    expect(requestScrollToMessage('msg-1')).toBe(false);
  });
});

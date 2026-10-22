import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ reconnect: vi.fn() }));

vi.mock('@client/app/hooks/useAgentExecution', () => ({
  useAgentExecutionDispatch: () => ({ reconnect: mocks.reconnect }),
}));

import { useSessionReconnectProbe } from './useSessionReconnectProbe';

type Props = { id: string | null | undefined };

describe('useSessionReconnectProbe', () => {
  beforeEach(() => {
    mocks.reconnect = vi.fn();
  });

  it('probes once per sessionId and again only when it changes', () => {
    const { rerender } = renderHook(({ id }: Props) => useSessionReconnectProbe(id), {
      initialProps: { id: 'A' },
    });
    expect(mocks.reconnect).toHaveBeenCalledTimes(1);
    expect(mocks.reconnect).toHaveBeenLastCalledWith('A');

    rerender({ id: 'A' });
    expect(mocks.reconnect).toHaveBeenCalledTimes(1);

    rerender({ id: 'B' });
    expect(mocks.reconnect).toHaveBeenCalledTimes(2);
    expect(mocks.reconnect).toHaveBeenLastCalledWith('B');
  });

  it.each([null, undefined])('does not probe for %s', id => {
    renderHook(() => useSessionReconnectProbe(id));
    expect(mocks.reconnect).not.toHaveBeenCalled();
  });

  it('does not re-probe when the reconnect identity changes, but uses the new one next time', () => {
    const first = mocks.reconnect;
    const { rerender } = renderHook(({ id }: Props) => useSessionReconnectProbe(id), {
      initialProps: { id: 'A' },
    });
    const second = vi.fn();
    mocks.reconnect = second;

    rerender({ id: 'A' });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();

    rerender({ id: 'B' });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith('B');
  });
});

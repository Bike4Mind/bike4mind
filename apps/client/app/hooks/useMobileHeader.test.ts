import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useMobileHeader, useMobileHeaderStore } from './useMobileHeader';

describe('useMobileHeader', () => {
  beforeEach(() => useMobileHeaderStore.setState({ title: null, action: null, owner: null }));

  it('names the page in the header while it is mounted, and clears it on unmount', () => {
    const action = 'help';
    const { unmount } = renderHook(() => useMobileHeader('Gears', action));

    expect(useMobileHeaderStore.getState()).toMatchObject({ title: 'Gears', action: 'help' });

    unmount();
    expect(useMobileHeaderStore.getState()).toMatchObject({ title: null, action: null });
  });

  it('leaves the action empty when none is given', () => {
    renderHook(() => useMobileHeader('Gears'));
    expect(useMobileHeaderStore.getState().action).toBeNull();
  });

  it('does not clear a title the next page already set when the old page unmounts late', () => {
    const outgoing = renderHook(() => useMobileHeader('Gears'));
    renderHook(() => useMobileHeader('Projects'));

    outgoing.unmount();
    expect(useMobileHeaderStore.getState().title).toBe('Projects');
  });
});

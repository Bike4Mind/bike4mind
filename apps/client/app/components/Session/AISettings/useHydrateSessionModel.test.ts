import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ISessionDocument } from '@bike4mind/common';
import { useHydrateSessionModel } from './useHydrateSessionModel';

const session = (id: string, lastUsedModel: string | null): ISessionDocument =>
  ({ id, lastUsedModel }) as ISessionDocument;

describe('useHydrateSessionModel', () => {
  it('hydrates the model when a session first loads', () => {
    const setModel = vi.fn();
    const { rerender } = renderHook(({ s }) => useHydrateSessionModel(s, setModel), {
      initialProps: { s: null as ISessionDocument | null },
    });

    rerender({ s: session('a', 'claude-opus-5') });

    expect(setModel).toHaveBeenCalledExactlyOnceWith('claude-opus-5');
  });

  // The #958 regression: the server rewrites lastUsedModel to the model that ran, then the
  // session refetches with a new object identity. That must NOT clobber the user's pick.
  it('does not re-hydrate on a refetch of the same session, even if lastUsedModel changed', () => {
    const setModel = vi.fn();
    const { rerender } = renderHook(({ s }) => useHydrateSessionModel(s, setModel), {
      initialProps: { s: session('a', 'claude-sonnet-5') },
    });
    expect(setModel).toHaveBeenCalledExactlyOnceWith('claude-sonnet-5');
    setModel.mockClear();

    // New object identity, same id, server-rewritten model -> ignored.
    rerender({ s: session('a', 'grok-3') });

    expect(setModel).not.toHaveBeenCalled();
  });

  it('hydrates again when a genuinely different session loads', () => {
    const setModel = vi.fn();
    const { rerender } = renderHook(({ s }) => useHydrateSessionModel(s, setModel), {
      initialProps: { s: session('a', 'claude-sonnet-5') },
    });
    setModel.mockClear();

    rerender({ s: session('b', 'grok-4.5') });

    expect(setModel).toHaveBeenCalledExactlyOnceWith('grok-4.5');
  });

  it('does nothing when the loaded session has no saved model', () => {
    const setModel = vi.fn();
    renderHook(() => useHydrateSessionModel(session('a', null), setModel));

    expect(setModel).not.toHaveBeenCalled();
  });
});

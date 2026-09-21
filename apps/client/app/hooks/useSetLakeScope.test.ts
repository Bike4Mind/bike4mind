import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useSetLakeScope from './useSetLakeScope';

const { setCurrentSession, updateSession, toastError } = vi.hoisted(() => ({
  setCurrentSession: vi.fn(),
  updateSession: vi.fn(),
  toastError: vi.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double for ISessionDocument
let currentSession: any = { id: 's1', name: 'Chat', retrievalTags: [], lakeScopeExplicit: false };

vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSession, setCurrentSession }),
}));
vi.mock('@client/app/hooks/data/sessions', () => ({
  useUpdateSession: () => ({ mutate: updateSession }),
}));
vi.mock('sonner', () => ({ toast: { error: toastError } }));

describe('useSetLakeScope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentSession = { id: 's1', name: 'Chat', retrievalTags: [], lakeScopeExplicit: false };
  });

  it('sends the named lakes as an explicit scope, and only that field', () => {
    const { result } = renderHook(() => useSetLakeScope());
    act(() => result.current(['datalake:research', 'datalake:legal']));

    // Minimal wire payload. Echoing the whole cached session would let a stale knowledgeIds
    // overwrite the server's - re-adding removed files and fanning them out to projects - from
    // what the user experienced as ticking a checkbox.
    expect(updateSession).toHaveBeenCalledWith(
      { id: 's1', lakeScope: ['datalake:research', 'datalake:legal'] },
      expect.objectContaining({ onError: expect.any(Function) })
    );
  });

  it('sends null for the all-lakes scope, not an empty array', () => {
    // `[]` on the wire means "ground on NO lake" - the opposite of the all-lakes scope the empty
    // picker selection represents. This is the assertion that catches that inversion.
    const { result } = renderHook(() => useSetLakeScope());
    act(() => result.current([]));

    expect(updateSession).toHaveBeenCalledWith(
      { id: 's1', lakeScope: null },
      expect.objectContaining({ onError: expect.any(Function) })
    );
  });

  it('updates the cached session optimistically, so the picker reflects the choice at once', () => {
    const { result } = renderHook(() => useSetLakeScope());
    act(() => result.current(['datalake:research']));

    expect(setCurrentSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's1', retrievalTags: ['datalake:research'], lakeScopeExplicit: true })
    );
  });

  it('marks the all-lakes scope as NOT explicit on the cached session', () => {
    currentSession = { id: 's1', name: 'Chat', retrievalTags: ['datalake:old'], lakeScopeExplicit: true };
    const { result } = renderHook(() => useSetLakeScope());
    act(() => result.current([]));

    // Both halves, because the flag alone decides whether the empty list reads as "no lake" or
    // "any lake" - a stale `true` beside an emptied list inverts the meaning.
    expect(setCurrentSession).toHaveBeenCalledWith(
      expect.objectContaining({ retrievalTags: [], lakeScopeExplicit: false })
    );
  });

  it('rolls the session back and says so when the write fails', () => {
    const before = currentSession;
    updateSession.mockImplementationOnce((_s: unknown, opts?: { onError?: () => void }) => opts?.onError?.());
    const { result } = renderHook(() => useSetLakeScope());
    act(() => result.current(['datalake:research']));

    // Otherwise the picker keeps claiming a scope the server refused, and every later reply is
    // grounded on lakes the UI is not showing.
    expect(setCurrentSession).toHaveBeenLastCalledWith(before);
    expect(toastError).toHaveBeenCalled();
  });

  it('does nothing on /new, where there is no session to carry the scope', () => {
    currentSession = null;
    const { result } = renderHook(() => useSetLakeScope());
    act(() => result.current(['datalake:research']));

    // The /new choice is parked in usePendingLakeScope and lands in the create body instead.
    expect(updateSession).not.toHaveBeenCalled();
    expect(setCurrentSession).not.toHaveBeenCalled();
  });
});

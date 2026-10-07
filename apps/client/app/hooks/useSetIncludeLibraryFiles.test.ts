import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useSetIncludeLibraryFiles from './useSetIncludeLibraryFiles';

const { setCurrentSession, updateSession, toastError, pending } = vi.hoisted(() => ({
  setCurrentSession: vi.fn(),
  updateSession: vi.fn(),
  toastError: vi.fn(),
  pending: { value: false },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double for ISessionDocument
let currentSession: any;

vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSession, setCurrentSession }),
}));
vi.mock('@client/app/hooks/data/sessions', () => ({
  useUpdateSession: () => ({ mutate: updateSession, isPending: pending.value }),
}));
vi.mock('sonner', () => ({ toast: { error: toastError } }));

describe('useSetIncludeLibraryFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pending.value = false;
    currentSession = { id: 's1', name: 'Chat', retrievalTags: ['datalake:research'], lakeScopeExplicit: true };
  });

  it('reads an unset flag on a lake chat as off, and turns it on with exactly one minimal PUT', () => {
    const { result } = renderHook(() => useSetIncludeLibraryFiles());
    expect(result.current.included).toBe(false);

    act(() => result.current.toggle());

    expect(setCurrentSession).toHaveBeenCalledWith(expect.objectContaining({ includeLibraryFiles: true }));
    expect(updateSession).toHaveBeenCalledTimes(1);
    expect(updateSession).toHaveBeenCalledWith(
      { id: 's1', includeLibraryFilesChoice: true },
      expect.objectContaining({ onError: expect.any(Function) })
    );
  });

  it('reads an unset flag on a chat naming no lake as on, and turns it off', () => {
    currentSession = { id: 's1', retrievalTags: [], lakeScopeExplicit: false };
    const { result } = renderHook(() => useSetIncludeLibraryFiles());
    expect(result.current.included).toBe(true);

    act(() => result.current.toggle());
    expect(updateSession.mock.calls[0][0]).toEqual({ id: 's1', includeLibraryFilesChoice: false });
  });

  it('reads an unset flag as on in a plain chat whose lake tags came from an attached file', () => {
    currentSession = { id: 's1', retrievalTags: ['datalake:research'] };
    const { result } = renderHook(() => useSetIncludeLibraryFiles());
    expect(result.current.included).toBe(true);
  });

  it('reads a lake named by its file-tag prefix as a lake, as the server does', () => {
    currentSession = { id: 's1', retrievalTags: ['acme:'], forceKnowledgeRetrieval: true };
    expect(renderHook(() => useSetIncludeLibraryFiles()).result.current.included).toBe(true);
    expect(renderHook(() => useSetIncludeLibraryFiles(['acme:'])).result.current.included).toBe(false);
  });

  it('rolls the session back and says so when the write fails', () => {
    const before = currentSession;
    const { result } = renderHook(() => useSetIncludeLibraryFiles());
    act(() => result.current.toggle());

    act(() => updateSession.mock.calls[0][1].onError());
    expect(setCurrentSession).toHaveBeenLastCalledWith(before);
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it('ignores a click while a write is in flight', () => {
    pending.value = true;
    const { result } = renderHook(() => useSetIncludeLibraryFiles());
    act(() => result.current.toggle());

    expect(updateSession).not.toHaveBeenCalled();
    expect(setCurrentSession).not.toHaveBeenCalled();
  });

  it('does nothing before a session exists', () => {
    currentSession = null;
    const { result } = renderHook(() => useSetIncludeLibraryFiles());
    act(() => result.current.toggle());
    expect(updateSession).not.toHaveBeenCalled();
  });
});

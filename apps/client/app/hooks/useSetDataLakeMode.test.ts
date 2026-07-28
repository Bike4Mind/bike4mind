import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useSetDataLakeMode from './useSetDataLakeMode';
import useDataLakeMode from './useDataLakeMode';

const { setCurrentSession, updateSession, toastError } = vi.hoisted(() => ({
  setCurrentSession: vi.fn(),
  updateSession: vi.fn(),
  toastError: vi.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double for ISessionDocument
let currentSession: any = { id: 's1', name: 'Chat', forceKnowledgeRetrieval: true };

vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSession, setCurrentSession }),
}));
vi.mock('@client/app/hooks/data/sessions', () => ({
  useUpdateSession: () => ({ mutate: updateSession }),
}));
vi.mock('sonner', () => ({ toast: { error: toastError } }));

describe('useSetDataLakeMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentSession = { id: 's1', name: 'Chat', forceKnowledgeRetrieval: true };
    useDataLakeMode.setState({ enabled: true, seededSessionId: 's1' });
  });

  it('turning off: flips the store to false and persists forceKnowledgeRetrieval:false', () => {
    const { result } = renderHook(() => useSetDataLakeMode());
    act(() => result.current(false));
    expect(useDataLakeMode.getState().enabled).toBe(false);
    expect(setCurrentSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's1', forceKnowledgeRetrieval: false })
    );
    expect(updateSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's1', forceKnowledgeRetrieval: false }),
      expect.objectContaining({ onError: expect.any(Function) })
    );
  });

  it('rolls back the store + session when persistence fails', () => {
    updateSession.mockImplementationOnce((_s: unknown, opts?: { onError?: () => void }) => opts?.onError?.());
    const { result } = renderHook(() => useSetDataLakeMode());
    act(() => result.current(false));
    // Rolled back to the pre-toggle state (enabled true, original session restored).
    expect(useDataLakeMode.getState().enabled).toBe(true);
    expect(setCurrentSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 's1', forceKnowledgeRetrieval: true })
    );
    expect(toastError).toHaveBeenCalled();
  });

  it('on /new (no session) flips only the store without persisting', () => {
    currentSession = null;
    useDataLakeMode.setState({ enabled: false, seededSessionId: null });
    const { result } = renderHook(() => useSetDataLakeMode());
    act(() => result.current(true));
    expect(useDataLakeMode.getState().enabled).toBe(true);
    expect(updateSession).not.toHaveBeenCalled();
  });
});

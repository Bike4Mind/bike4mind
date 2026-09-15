import { renderHook, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { RefObject } from 'react';
import { useBulkActions } from './useBulkActions';

// Module mocks

const mockMutateAsync = vi.fn();
const mockNavigate = vi.fn();

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mockNavigate }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSessionId: null }),
}));
vi.mock('@client/app/hooks/data/sessions', () => ({
  useDeleteSessions: () => ({ mutateAsync: mockMutateAsync, isPending: false }),
  useDownloadSession: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Helpers

const makeRef = <T>(value: T): RefObject<T> => ({ current: value }) as RefObject<T>;

const defaultArgs = {
  combinedSessions: [],
  filteredFavoriteSession: [],
  selectableSessions: [] as { id: string }[],
  filtersAnchorRef: makeRef<HTMLDivElement | null>(null),
  sidenavRef: makeRef<HTMLDivElement | null>(null),
  closeFilters: vi.fn(),
};

// Tests

beforeEach(() => {
  vi.clearAllMocks();
  mockMutateAsync.mockResolvedValue({ newLastNotebookId: null });
});

describe('useBulkActions — visibleSelectedIds', () => {
  it('only includes IDs present in both selectedItems and selectableSessions', () => {
    const { result } = renderHook(() =>
      useBulkActions({
        ...defaultArgs,
        selectableSessions: [{ id: 'visible-1' }, { id: 'visible-2' }],
      })
    );

    act(() => {
      result.current.handleToggleItemSelection('visible-1');
      result.current.handleToggleItemSelection('ghost-x'); // not in selectableSessions
    });

    expect(result.current.visibleSelectedIds.has('visible-1')).toBe(true);
    expect(result.current.visibleSelectedIds.has('ghost-x')).toBe(false);
    // Raw selectedItems set is unaffected - the ghost is still tracked, just not visible
    expect(result.current.selectedItems.has('ghost-x')).toBe(true);
  });

  it('drops a ghost selection when selectableSessions shrinks after a projectsData refetch', () => {
    const { result, rerender } = renderHook(
      ({ selectableSessions }) => useBulkActions({ ...defaultArgs, selectableSessions }),
      { initialProps: { selectableSessions: [{ id: 'session-1' }] } }
    );

    // User selects the session while it is visible in the loose list
    act(() => {
      result.current.handleToggleItemSelection('session-1');
    });
    expect(result.current.visibleSelectedIds.has('session-1')).toBe(true);

    // projectsData refetches: session-1's project appears -> session-1 leaves selectableSessions
    rerender({ selectableSessions: [] });

    expect(result.current.selectedItems.has('session-1')).toBe(true); // raw set preserved
    expect(result.current.visibleSelectedIds.has('session-1')).toBe(false); // excluded from visible
  });
});

describe('useBulkActions — handleDeleteConfirm', () => {
  it('only passes visibleSelectedIds to deleteSessions, excluding ghost selections', async () => {
    const { result } = renderHook(() =>
      useBulkActions({
        ...defaultArgs,
        selectableSessions: [{ id: 'session-a' }],
      })
    );

    act(() => {
      result.current.handleToggleItemSelection('session-a'); // visible
      result.current.handleToggleItemSelection('ghost-b'); // not in selectableSessions
    });

    await act(async () => {
      await result.current.handleDeleteConfirm();
    });

    expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockMutateAsync).toHaveBeenCalledWith(['session-a']);
  });
});

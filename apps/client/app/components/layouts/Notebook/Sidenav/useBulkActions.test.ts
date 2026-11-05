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
const { mockPost, mockDelete, mockToast } = vi.hoisted(() => ({
  mockPost: vi.fn(),
  mockDelete: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: mockPost, delete: mockDelete } }));
vi.mock('sonner', () => ({ toast: mockToast }));

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

describe('useBulkActions - handleFavoriteSelected', () => {
  const makeSessions = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i}` }));

  async function favorite(sessions: { id: string }[], favorites: { id: string }[] = []) {
    const { result } = renderHook(() =>
      useBulkActions({
        ...defaultArgs,
        combinedSessions: sessions as never,
        filteredFavoriteSession: favorites,
        selectableSessions: sessions,
      })
    );
    act(() => result.current.handleToggleSelectAll());
    await act(async () => {
      await result.current.handleFavoriteSelected();
    });
    return result;
  }

  beforeEach(() => {
    mockPost.mockImplementation(async (_url: string, body: { add: string[]; remove: string[] }) => ({
      data: {
        okCount: body.add.length + body.remove.length,
        results: [...body.add, ...body.remove].map(id => ({ id, ok: true })),
      },
    }));
  });

  it('sends one bulk request for 10 items, splitting add and remove', async () => {
    const sessions = makeSessions(10);
    await favorite(sessions, [{ id: 's0' }, { id: 's1' }]);

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledWith('/api/sessions/bulk', {
      action: 'favorite',
      add: sessions.slice(2).map(s => s.id),
      remove: ['s0', 's1'],
    });
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockToast.success).toHaveBeenCalled();
  });

  it('chunks 150 items into two requests', async () => {
    await favorite(makeSessions(150));

    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(mockPost.mock.calls.every(([url]) => url === '/api/sessions/bulk')).toBe(true);
    expect(mockPost.mock.calls[0][1].add).toHaveLength(100);
    expect(mockPost.mock.calls[1][1].add).toHaveLength(50);
  });

  it('reports a partial result when some items fail', async () => {
    mockPost.mockResolvedValue({
      data: { okCount: 7, results: makeSessions(10).map((session, index) => ({ id: session.id, ok: index < 7 })) },
    });
    const result = await favorite(makeSessions(10));
    expect([...result.current.selectedItems]).toEqual(['s7', 's8', 's9']);

    expect(mockToast.warning).toHaveBeenCalledWith('Updated favorites for 7 of 10 items');
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it('keeps the committed chunk count when a later chunk fails in transport', async () => {
    mockPost
      .mockImplementationOnce(async (_url: string, body: { add: string[] }) => ({
        data: { okCount: body.add.length, results: body.add.map(id => ({ id, ok: true })) },
      }))
      .mockRejectedValueOnce(new Error('network'));
    const result = await favorite(makeSessions(150));
    expect(result.current.selectedItems.size).toBe(0);

    expect(mockToast.warning).toHaveBeenCalledWith('Updated favorites for 100 of 150 items');
    expect(mockToast.error).toHaveBeenCalledWith('Failed to update the remaining favorites');
  });

  it('sends nothing for an empty selection', async () => {
    await favorite([]);
    expect(mockPost).not.toHaveBeenCalled();
  });
});

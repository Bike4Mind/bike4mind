import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import type { IFabFileDocument } from '@bike4mind/common';
import {
  useBulkDeleteFiles,
  useDeleteAllFiles,
  useGetFabFilesBySessionId,
  useGetFabFilesByQuestId,
  useUpdateFabFile,
} from './fabFiles';
import useSessionLayout, { setPendingMessageFiles } from '@client/app/hooks/useSessionLayout';

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: { success: (...args: unknown[]) => toastSuccess(...args), error: (...args: unknown[]) => toastError(...args) },
}));

// Mock the axios-backed api context - we only care that the GET/DELETE is (or isn't) fired.
const apiGet = vi.fn();
const apiDelete = vi.fn();
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    delete: (...args: unknown[]) => apiDelete(...args),
  },
}));

const updateFabFileOnServer = vi.fn();
vi.mock('@client/app/utils/filesAPICalls', () => ({
  updateFabFileOnServer: (...args: unknown[]) => updateFabFileOnServer(...args),
}));

const makeWrapper = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  Wrapper.displayName = 'TestQueryClientWrapper';
  return Wrapper;
};

const renderSession = (sessionId: string, enabled = true) =>
  renderHook(() => useGetFabFilesBySessionId(sessionId, { enabled }), { wrapper: makeWrapper() });

const renderQuest = (questId: string, enabled = true) =>
  renderHook(() => useGetFabFilesByQuestId(questId, { enabled }), { wrapper: makeWrapper() });

describe('useGetFabFilesBySessionId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Regression: when the chat input is hydrated with an optimistic session id
  // (pre-navigation, before the real id is minted) the hook used to fire
  // GET /api/sessions/optimistic-session-*/files which the server rejects
  // with 400 "Invalid session ID format".
  it('does not fetch while sessionId is an optimistic placeholder', () => {
    renderSession('optimistic-session-abc-123');
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('fetches for a real (non-optimistic) sessionId', async () => {
    apiGet.mockResolvedValue({ data: [] });
    renderSession('507f1f77bcf86cd799439011');

    await waitFor(() => {
      expect(apiGet).toHaveBeenCalledWith('/api/sessions/507f1f77bcf86cd799439011/files');
    });
  });

  it('respects the caller-supplied enabled=false', () => {
    renderSession('507f1f77bcf86cd799439011', false);
    expect(apiGet).not.toHaveBeenCalled();
  });
});

describe('useGetFabFilesByQuestId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Same class of bug on the quest-id sibling: quest ids can be
  // `optimistic-quest-*` placeholders before the server response lands. The
  // guard used to live at the MessageContent.tsx caller; it now lives in the
  // hook so new callers can't re-introduce the 400.
  it('does not fetch while questId is an optimistic placeholder', () => {
    renderQuest('optimistic-quest-abc-123');
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('fetches for a real (non-optimistic) questId', async () => {
    apiGet.mockResolvedValue({ data: [] });
    renderQuest('507f1f77bcf86cd799439012');

    await waitFor(() => {
      expect(apiGet).toHaveBeenCalledWith('/api/quests/507f1f77bcf86cd799439012/files');
    });
  });

  it('respects the caller-supplied enabled=false', () => {
    renderQuest('507f1f77bcf86cd799439012', false);
    expect(apiGet).not.toHaveBeenCalled();
  });
});

describe('useDeleteAllFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPendingMessageFiles([]);
  });

  // Regression (#1279): pendingMessageFiles is a Zustand snapshot, not backed by the
  // fabFiles query cache, so the ['fabFiles'] invalidation this mutation already does never
  // reaches it - a composer chip attached-but-not-sent this session kept pointing at a
  // deleted FabFile after "Delete All Knowledge".
  it('clears pendingMessageFiles so stale composer chips do not survive the bulk delete', async () => {
    apiDelete.mockResolvedValue({});
    setPendingMessageFiles([
      {
        fabFile: { id: 'file-1', fileName: 'notes.txt', mimeType: 'text/plain' } as IFabFileDocument,
        uploadProgress: 100,
        status: 'complete',
        scope: 'notebook',
        uploadSessionId: 'session-1',
      },
    ]);

    const { result } = renderHook(() => useDeleteAllFiles(), { wrapper: makeWrapper() });
    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(apiDelete).toHaveBeenCalledWith('/api/files');
    expect(useSessionLayout.getState().pendingMessageFiles).toEqual([]);
  });

  // Deleting all files zeroes every tag's file count, so the tag browser's cached counts go
  // stale the same way useDeleteFile/useBulkDeleteFiles already guard against.
  it('invalidates file-tags so per-tag counts do not go stale', async () => {
    apiDelete.mockResolvedValue({});

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const Wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    Wrapper.displayName = 'TestQueryClientWrapper';

    const { result } = renderHook(() => useDeleteAllFiles(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync();
    });

    const keys = invalidate.mock.calls.map(call => JSON.stringify((call[0] as { queryKey: unknown[] })?.queryKey));
    expect(keys).toContain(JSON.stringify(['file-tags']));
  });
});

describe('useBulkDeleteFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a success toast when the batch actually removed something', async () => {
    apiDelete.mockResolvedValue({
      data: { message: 'Deleted 1 file(s)', results: { deleted: ['f1'], unshared: [], notFound: [], failed: [] } },
    });

    const { result } = renderHook(() => useBulkDeleteFiles(), { wrapper: makeWrapper() });
    await act(async () => {
      await result.current.mutateAsync(['f1']);
    });

    expect(toastSuccess).toHaveBeenCalledWith('Deleted 1 file(s)');
    expect(toastError).not.toHaveBeenCalled();
  });

  // Regression: a batch where every id was notFound (including the access-denied ids that server
  // folds into notFound to avoid leaking their existence) used to render as a green success toast
  // even though nothing was removed.
  it('shows an error toast, not success, when nothing was actually removed', async () => {
    apiDelete.mockResolvedValue({
      data: {
        message: '1 file(s) not found',
        results: { deleted: [], unshared: [], notFound: ['f1'], failed: [] },
      },
    });

    const { result } = renderHook(() => useBulkDeleteFiles(), { wrapper: makeWrapper() });
    await act(async () => {
      await result.current.mutateAsync(['f1']);
    });

    expect(toastError).toHaveBeenCalledWith('1 file(s) not found');
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

describe('useUpdateFabFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // PUT /api/files/[id] replaces the whole tags array, and the tag list's fileCount is derived
  // from the files that carry each tag - so this route going through without refreshing the tag
  // surfaces leaves every per-tag count stale. The bare prefix also covers ['file-tags','counts'].
  it('invalidates the tag surfaces, whose counts this route can change', async () => {
    updateFabFileOnServer.mockResolvedValue({ id: 'f1' });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const Wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    Wrapper.displayName = 'TestQueryClientWrapper';

    const { result } = renderHook(() => useUpdateFabFile(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 'f1', tags: [{ name: 'invoices', strength: 1 }] });
    });

    const keys = invalidate.mock.calls.map(call => JSON.stringify((call[0] as { queryKey: unknown[] })?.queryKey));
    expect(keys).toContain(JSON.stringify(['file-tags']));
  });
});

import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAdminUserNoteHistory, useAdminUserNotes, useWriteAdminUserNote } from './adminUserNotes';

const mocks = vi.hoisted(() => ({ get: vi.fn(), request: vi.fn(), error: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get, request: mocks.request } }));
vi.mock('sonner', () => ({ toast: { error: mocks.error } }));

const setup = () => {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={cache}>{children}</QueryClientProvider>
  );
  return { cache, wrapper };
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe('admin user notes hooks', () => {
  it('does not read notes without permission and resumes with the correct user and cursor', async () => {
    const { wrapper } = setup();
    mocks.get
      .mockResolvedValueOnce({ data: { entries: [{ id: 'newest' }], nextCursor: 'older-cursor' } })
      .mockResolvedValueOnce({ data: { entries: [{ id: 'older' }], nextCursor: null } });
    const view = renderHook(({ enabled }) => useAdminUserNotes('user-1', enabled), {
      wrapper,
      initialProps: { enabled: false },
    });
    expect(mocks.get).not.toHaveBeenCalled();
    view.rerender({ enabled: true });
    await waitFor(() => expect(view.result.current.hasNextPage).toBe(true));
    await act(async () => {
      await view.result.current.fetchNextPage();
    });
    expect(mocks.get).toHaveBeenNthCalledWith(1, '/api/admin/users/user-1/notes', {
      params: { cursor: undefined, limit: 25 },
    });
    expect(mocks.get).toHaveBeenLastCalledWith('/api/admin/users/user-1/notes', {
      params: { cursor: 'older-cursor', limit: 25 },
    });
    await waitFor(() => expect(view.result.current.hasNextPage).toBe(false));
    expect(view.result.current.data?.pages.flatMap(page => page.entries.map(entry => entry.id))).toEqual([
      'newest',
      'older',
    ]);
  });

  it('keeps the note identity when requesting older history', async () => {
    const { wrapper } = setup();
    mocks.get
      .mockResolvedValueOnce({ data: { entries: [], nextCursor: 'revision-cursor' } })
      .mockResolvedValueOnce({ data: { entries: [], nextCursor: null } });
    const view = renderHook(() => useAdminUserNoteHistory('user-1', 'note-1'), { wrapper });
    await waitFor(() => expect(view.result.current.hasNextPage).toBe(true));
    await act(async () => {
      await view.result.current.fetchNextPage();
    });
    expect(mocks.get).toHaveBeenLastCalledWith('/api/admin/users/user-1/notes', {
      params: { noteId: 'note-1', cursor: 'revision-cursor', limit: 25 },
    });
  });

  it('refreshes notes, revision history and timeline after a successful write', async () => {
    const { cache, wrapper } = setup();
    const keys = [
      ['admin', 'users', 'user-1', 'notes'],
      ['admin', 'users', 'user-1', 'notes', 'note-1', 'history'],
      ['admin', 'users', 'user-1', 'timeline'],
    ];
    keys.forEach(key => cache.setQueryData(key, { existing: true }));
    cache.setQueryData(['admin', 'users', 'other-user', 'notes'], { existing: true });
    mocks.request.mockResolvedValue({ data: { id: 'note-1', version: 1 } });
    const view = renderHook(() => useWriteAdminUserNote('user-1'), { wrapper });
    await act(async () => {
      await view.result.current.mutateAsync({ body: 'New note' });
    });
    expect(mocks.request).toHaveBeenCalledWith({
      url: '/api/admin/users/user-1/notes',
      method: 'POST',
      data: { body: 'New note' },
    });
    keys.forEach(key => expect(cache.getQueryState(key)?.isInvalidated).toBe(true));
    expect(cache.getQueryState(['admin', 'users', 'other-user', 'notes'])?.isInvalidated).toBe(false);
  });

  it('surfaces a rejected edit and refreshes stale notes and history without reporting success', async () => {
    const { cache, wrapper } = setup();
    const notesKey = ['admin', 'users', 'user-1', 'notes'];
    const historyKey = [...notesKey, 'note-1', 'history'];
    cache.setQueryData(notesKey, { existing: true });
    cache.setQueryData(historyKey, { existing: true });
    const failure = new Error('Concurrent edit');
    mocks.request.mockRejectedValue(failure);
    const view = renderHook(() => useWriteAdminUserNote('user-1'), { wrapper });
    const input = { noteId: 'note-1', version: 1, body: 'My edit' };
    await act(async () => {
      await expect(view.result.current.mutateAsync(input)).rejects.toBe(failure);
    });
    expect(mocks.request).toHaveBeenCalledWith({ url: '/api/admin/users/user-1/notes', method: 'PATCH', data: input });
    expect(mocks.error).toHaveBeenCalledWith('The note was not saved. Reload notes and try again.');
    expect(cache.getQueryState(notesKey)?.isInvalidated).toBe(true);
    expect(cache.getQueryState(historyKey)?.isInvalidated).toBe(true);
    await waitFor(() => expect(view.result.current.isError).toBe(true));
  });
});

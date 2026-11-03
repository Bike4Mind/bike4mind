import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { AxiosError, type AxiosResponse } from 'axios';
import { ADMIN_ASSISTANT_SURFACE } from '@bike4mind/common';

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: h.get, post: h.post } }));

import { useAdminAssistantSession } from './useAdminAssistantSession';

const STORAGE_KEY = 'admin-assistant-session-id';

describe('useAdminAssistantSession', () => {
  beforeEach(() => {
    localStorage.clear();
    h.get.mockReset();
    h.post.mockReset();
    h.post.mockResolvedValue({ data: { id: 'new-session' } });
  });

  it('creates a session with the admin-assistant surface when none is saved', async () => {
    const { result } = renderHook(() => useAdminAssistantSession(true));

    await waitFor(() => expect(result.current).toBe('new-session'));
    expect(h.post).toHaveBeenCalledWith('/api/sessions/create', {
      name: 'Admin Assistant',
      surface: ADMIN_ASSISTANT_SURFACE,
    });
    expect(localStorage.getItem(STORAGE_KEY)).toBe('new-session');
  });

  it('reuses a saved session that has the admin-assistant surface', async () => {
    localStorage.setItem(STORAGE_KEY, 'saved');
    h.get.mockResolvedValue({ data: { id: 'saved', surface: ADMIN_ASSISTANT_SURFACE } });

    const { result } = renderHook(() => useAdminAssistantSession(true));

    await waitFor(() => expect(result.current).toBe('saved'));
    expect(h.post).not.toHaveBeenCalled();
  });

  it('replaces a saved session without the surface', async () => {
    localStorage.setItem(STORAGE_KEY, 'plain');
    h.get.mockResolvedValue({ data: { id: 'plain' } });

    const { result } = renderHook(() => useAdminAssistantSession(true));

    await waitFor(() => expect(result.current).toBe('new-session'));
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('new-session');
  });

  it('replaces a saved session that no longer exists', async () => {
    localStorage.setItem(STORAGE_KEY, 'gone');
    h.get.mockRejectedValue(new AxiosError('gone', '404', undefined, undefined, { status: 404 } as AxiosResponse));

    const { result } = renderHook(() => useAdminAssistantSession(true));

    await waitFor(() => expect(result.current).toBe('new-session'));
    expect(h.post).toHaveBeenCalledTimes(1);
  });

  it('keeps the saved session on a transient fetch error', async () => {
    localStorage.setItem(STORAGE_KEY, 'saved');
    h.get.mockRejectedValue(new AxiosError('boom', '500', undefined, undefined, { status: 500 } as AxiosResponse));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { result } = renderHook(() => useAdminAssistantSession(true));

    await waitFor(() => expect(result.current).toBe('saved'));
    expect(h.post).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('saved');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('keeps the saved session on a network error', async () => {
    localStorage.setItem(STORAGE_KEY, 'saved');
    h.get.mockRejectedValue(new Error('Network Error'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { result } = renderHook(() => useAdminAssistantSession(true));

    await waitFor(() => expect(result.current).toBe('saved'));
    expect(h.post).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does nothing when not enabled', async () => {
    const { result } = renderHook(() => useAdminAssistantSession(false));

    await Promise.resolve();
    expect(result.current).toBeNull();
    expect(h.get).not.toHaveBeenCalled();
    expect(h.post).not.toHaveBeenCalled();
  });
});

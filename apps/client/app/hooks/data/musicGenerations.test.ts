// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: h.get, post: vi.fn() } }));
vi.mock('@client/app/contexts/WebsocketContext', () => ({
  ReadyState: { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
  useWebsocket: () => ({ readyState: 1 }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

import { musicJob, musicOutput } from './__test__/musicGenerationFixtures';
import { AWAITING_OUTPUT_MAX_POLL_AGE_MS, PENDING_SCAN_POLL_MS, SOCKET_DOWN_POLL_MS } from './generationJobPolling';
import { fabFileKeys } from './fabFileKeys';
import { musicGenerationKeys } from './musicGenerationKeys';
import { musicGenerationPollInterval, useMusicGeneration } from './musicGenerations';

const NOW = Date.parse('2026-10-07T00:00:10.000Z');

describe('musicGenerationPollInterval', () => {
  it('does not poll without data', () => {
    expect(musicGenerationPollInterval(undefined, true, NOW)).toBe(false);
  });

  it('polls a live job only while the socket is down', () => {
    expect(musicGenerationPollInterval(musicJob({ state: 'running' }), false, NOW)).toBe(SOCKET_DOWN_POLL_MS);
    expect(musicGenerationPollInterval(musicJob({ state: 'running' }), true, NOW)).toBe(false);
  });

  it('keeps polling a succeeded job with no output yet, then gives up', () => {
    const job = musicJob({ state: 'succeeded', output: null });
    expect(musicGenerationPollInterval(job, true, NOW)).toBe(SOCKET_DOWN_POLL_MS);
    expect(musicGenerationPollInterval(job, true, NOW + AWAITING_OUTPUT_MAX_POLL_AGE_MS)).toBe(false);
  });

  it('polls a scanning song and stops for an unavailable or failed one', () => {
    const scanning = musicJob({
      state: 'succeeded',
      output: musicOutput({ availability: 'pending_scan', url: null, expires_at: null }),
    });
    expect(musicGenerationPollInterval(scanning, true, NOW)).toBe(PENDING_SCAN_POLL_MS);
    const gone = musicJob({
      state: 'succeeded',
      output: musicOutput({ availability: 'unavailable', url: null, expires_at: null }),
    });
    expect(musicGenerationPollInterval(gone, true, NOW)).toBe(false);
    expect(musicGenerationPollInterval(musicJob({ state: 'failed' }), true, NOW)).toBe(false);
  });

  it('schedules a re-sign for a ready song', () => {
    const ready = musicJob({ state: 'succeeded', output: musicOutput() });
    expect(musicGenerationPollInterval(ready, true, NOW)).toBeGreaterThan(0);
  });
});

describe('useMusicGeneration file list refresh', () => {
  let queryClient: QueryClient;
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const withoutFile = musicJob({ state: 'succeeded', output: musicOutput({ file_id: null }) });
  const withFile = musicJob({ state: 'succeeded', output: musicOutput({ file_id: 'file-1' }) });

  beforeEach(() => {
    h.get.mockReset();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it('invalidates the own files the first time the song file appears', async () => {
    queryClient.setQueryData(musicGenerationKeys.detail('music-1'), withoutFile);
    h.get.mockResolvedValue({ data: withFile });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useMusicGeneration('music-1'), { wrapper });
    await result.current.refetch();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: fabFileKeys.own });
  });

  it('does not invalidate on the initial load', async () => {
    h.get.mockResolvedValue({ data: withFile });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useMusicGeneration('music-1'), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(withFile));
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: fabFileKeys.own });
  });

  it('does not invalidate when the file was already there', async () => {
    queryClient.setQueryData(musicGenerationKeys.detail('music-1'), withFile);
    h.get.mockResolvedValue({ data: withFile });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useMusicGeneration('music-1'), { wrapper });
    await result.current.refetch();
    expect(h.get).toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: fabFileKeys.own });
  });
});

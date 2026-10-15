// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { AxiosError, AxiosHeaders } from 'axios';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MusicGeneration } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  selectedAccount: null as { id: string; personal: boolean } | null,
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: h.get, post: h.post } }));
vi.mock('@client/app/contexts/WebsocketContext', () => ({
  ReadyState: { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
  useWebsocket: () => ({ readyState: 1 }),
}));
vi.mock('sonner', () => ({ toast: { success: h.toastSuccess, error: h.toastError } }));
vi.mock('@client/app/components/Credits/AccountSelector', () => ({
  useSelectedAccount: { getState: () => ({ selectedAccount: h.selectedAccount }) },
}));

import { musicJob, musicOutput } from './__test__/musicGenerationFixtures';
import { AWAITING_OUTPUT_MAX_POLL_AGE_MS, PENDING_SCAN_POLL_MS, SOCKET_DOWN_POLL_MS } from './generationJobPolling';
import { CREDITS_BALANCE_KEY } from './credits';
import { fabFileKeys } from './fabFileKeys';
import type { MusicGenerationList } from './musicGenerationCache';
import { musicGenerationKeys } from './musicGenerationKeys';
import {
  MUSIC_GALLERY_PAGE_SIZE,
  musicGenerationPollInterval,
  useCancelMusicGeneration,
  useCreateMusicGeneration,
  useMusicGeneration,
  useMusicGenerations,
  useMusicModels,
} from './musicGenerations';
import { GENERATION_RATE_LIMITED_MESSAGE } from './videoGenerationErrors';

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

describe('useMusicGeneration error handling', () => {
  let queryClient: QueryClient;
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const httpError = (status: number) =>
    new AxiosError('failed', 'ERR_BAD_RESPONSE', undefined, undefined, {
      status,
      data: {},
      statusText: '',
      headers: {},
      config: { headers: {} } as never,
    });

  beforeEach(() => {
    h.get.mockReset();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it('does not retry a missing (404) job', async () => {
    h.get.mockRejectedValue(httpError(404));
    const { result } = renderHook(() => useMusicGeneration('music-1'), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(h.get).toHaveBeenCalledTimes(1);
  });

  it('does not retry a rate-limited (429) read', async () => {
    h.get.mockRejectedValue(httpError(429));
    const { result } = renderHook(() => useMusicGeneration('music-1'), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(h.get).toHaveBeenCalledTimes(1);
  });

  it('retries a server error (500)', async () => {
    // retryDelay: 0 keeps the retry immediate so the assertion does not depend on the backoff wall clock.
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
    h.get.mockRejectedValueOnce(httpError(500)).mockResolvedValue({ data: musicJob({ id: 'music-1' }) });
    const { result } = renderHook(() => useMusicGeneration('music-1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(h.get).toHaveBeenCalledTimes(2);
  });
});

describe('useCancelMusicGeneration', () => {
  let queryClient: QueryClient;
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);

  beforeEach(() => {
    h.post.mockReset();
    h.toastError.mockReset();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });

  it('posts the cancel and writes the cancelled job into the detail cache', async () => {
    queryClient.setQueryData(musicGenerationKeys.detail('music-1'), musicJob({ id: 'music-1', state: 'running' }));
    const cancelled = musicJob({ id: 'music-1', state: 'cancelled', updated_at: '2026-10-07T00:01:00.000Z' });
    h.post.mockResolvedValue({ data: cancelled });
    const { result } = renderHook(() => useCancelMusicGeneration(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('music-1');
    });
    expect(h.post).toHaveBeenCalledWith('/api/v1/music-generations/music-1/cancel');
    expect(queryClient.getQueryData<MusicGeneration>(musicGenerationKeys.detail('music-1'))?.state).toBe('cancelled');
  });

  it('toasts the rate-limit message on a 429', async () => {
    h.post.mockRejectedValue(Object.assign(new AxiosError('Request failed'), { response: { status: 429, data: {} } }));
    const { result } = renderHook(() => useCancelMusicGeneration(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('music-1').catch(() => undefined);
    });
    expect(h.toastError).toHaveBeenCalledWith(GENERATION_RATE_LIMITED_MESSAGE);
  });

  it('toasts a generic message on any other failure', async () => {
    h.post.mockRejectedValue(Object.assign(new AxiosError('Request failed'), { response: { status: 500, data: {} } }));
    const { result } = renderHook(() => useCancelMusicGeneration(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('music-1').catch(() => undefined);
    });
    expect(h.toastError).toHaveBeenCalledWith('Could not cancel the song. Try again.');

const axiosError = (status: number, data: unknown): AxiosError =>
  new AxiosError('request failed', String(status), undefined, undefined, {
    status,
    statusText: '',
    data,
    headers: {},
    config: { headers: new AxiosHeaders() },
  });

describe('music Studio hooks', () => {
  let queryClient: QueryClient;
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);

  beforeEach(() => {
    h.get.mockReset();
    h.post.mockReset();
    h.toastSuccess.mockReset();
    h.toastError.mockReset();
    h.selectedAccount = null;
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });

  it('useMusicModels reads the usable models', async () => {
    h.get.mockResolvedValue({ data: { models: [{ id: 'test-music' }] } });
    const { result } = renderHook(() => useMusicModels(), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([{ id: 'test-music' }]));
    expect(h.get).toHaveBeenCalledWith('/api/v1/music-models');
  });

  it('useMusicGenerations reads a page and seeds every job into its detail entry', async () => {
    const job = musicJob({ id: 'music-7' });
    h.get.mockResolvedValue({ data: { data: [job], next_cursor: 'c2' } });
    const { result } = renderHook(() => useMusicGenerations(), { wrapper });
    await waitFor(() => expect(result.current.data?.pages[0].data).toEqual([job]));
    expect(h.get).toHaveBeenCalledWith('/api/v1/music-generations', { params: { limit: MUSIC_GALLERY_PAGE_SIZE } });
    expect(queryClient.getQueryData(musicGenerationKeys.detail('music-7'))).toEqual(job);
    expect(result.current.hasNextPage).toBe(true);
  });

  it('useCreateMusicGeneration bills the switcher account, prepends the job and refreshes credits', async () => {
    h.selectedAccount = { id: 'org-1', personal: false };
    const existing = musicJob({ id: 'music-old' });
    const created = musicJob({ id: 'music-new', state: 'pending' });
    const list: MusicGenerationList = { pages: [{ data: [existing], next_cursor: null }], pageParams: [undefined] };
    queryClient.setQueryData(musicGenerationKeys.list, list);
    h.post.mockResolvedValue({ data: created });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useCreateMusicGeneration(), { wrapper });

    await act(() => result.current.mutateAsync({ model: 'test-music', prompt: 'a song', instrumental: true }));

    expect(h.post).toHaveBeenCalledWith('/api/v1/music-generations', {
      model: 'test-music',
      prompt: 'a song',
      instrumental: true,
      organization_id: 'org-1',
    });
    const cached = queryClient.getQueryData<MusicGenerationList>(musicGenerationKeys.list);
    expect(cached?.pages[0].data.map(job => job.id)).toEqual(['music-new', 'music-old']);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: CREDITS_BALANCE_KEY });
    expect(h.toastSuccess).toHaveBeenCalledWith('Song generation started');
  });

  it('useCreateMusicGeneration toasts the message for the refusal code, not the server text', async () => {
    h.post.mockRejectedValue(axiosError(422, { errorCode: 'lyrics_with_instrumental', error: 'provider words' }));
    const { result } = renderHook(() => useCreateMusicGeneration(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ model: 'test-music', prompt: 'a song' }).catch(() => undefined);
    });
    expect(h.toastError).toHaveBeenCalledWith('Remove the lyrics, or turn off Instrumental.');
  });

  it('useCancelMusicGeneration writes the job into the gallery row', async () => {
    const running = musicJob({ id: 'music-1', state: 'running' });
    const list: MusicGenerationList = { pages: [{ data: [running], next_cursor: null }], pageParams: [undefined] };
    queryClient.setQueryData(musicGenerationKeys.list, list);
    const cancelled = musicJob({ id: 'music-1', state: 'cancelled', updated_at: '2026-10-07T00:01:00.000Z' });
    h.post.mockResolvedValue({ data: cancelled });
    const { result } = renderHook(() => useCancelMusicGeneration(), { wrapper });

    await act(() => result.current.mutateAsync('music-1'));

    expect(h.post).toHaveBeenCalledWith('/api/v1/music-generations/music-1/cancel');
    const cached = queryClient.getQueryData<MusicGenerationList>(musicGenerationKeys.list);
    expect(cached?.pages[0].data[0].state).toBe('cancelled');
  });
});

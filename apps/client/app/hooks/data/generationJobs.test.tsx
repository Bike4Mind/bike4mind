import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { AxiosError, AxiosHeaders } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ get: vi.fn(), readyState: 1 }));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: h.get } }));
vi.mock('@client/app/contexts/WebsocketContext', () => ({
  ReadyState: { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
  useWebsocket: () => ({ readyState: h.readyState }),
}));

import { musicJob } from './__test__/musicGenerationFixtures';
import { videoJob } from './__test__/videoGenerationFixtures';
import { GENERATION_GALLERY_PAGE_SIZE, useGenerationJob, useGenerationJobs } from './generationJobs';
import { SOCKET_DOWN_POLL_MS } from './generationJobPolling';
import { ERRORED_RELOAD_MS, chatImageJobKeys, type ChatImageJob } from './imageJobs';
import { musicGenerationKeys } from './musicGenerationKeys';
import type { StudioImageJob } from './studioImageJobs';
import { videoGenerationKeys } from './videoGenerationKeys';

const studioImageJob = (overrides: Partial<StudioImageJob> = {}): StudioImageJob => ({
  id: 'img-1',
  groupId: null,
  purpose: null,
  state: 'running',
  request: { model: 'gpt-image-1.5', mode: 'generate', prompt: 'a fox' } as StudioImageJob['request'],
  error: null,
  output: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  ...overrides,
});

const chatImageJob = (overrides: Partial<ChatImageJob> = {}): ChatImageJob => ({
  id: 'img-1',
  object: 'image_generation',
  state: 'running',
  model: 'gpt-image-1.5',
  mode: 'generate',
  prompt: 'a fox',
  group_id: null,
  source: 'chat',
  error: null,
  output: null,
  credits: { reserved: 4, settled: null },
  created_at: '2026-11-01T00:00:00.000Z',
  updated_at: '2026-11-01T00:00:00.000Z',
  ...overrides,
});

const httpError = (status: number) =>
  new AxiosError('failed', String(status), undefined, undefined, {
    status,
    statusText: '',
    headers: {},
    config: { headers: new AxiosHeaders() },
    data: null,
  });

let queryClient: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

beforeEach(() => {
  h.get.mockReset();
  h.readyState = 1;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useGenerationJobs', () => {
  it.each([
    ['video', '/api/v1/video-generations', videoJob({ id: 'job-a' }), videoGenerationKeys.detail('job-a')],
    ['music', '/api/v1/music-generations', musicJob({ id: 'job-a' }), musicGenerationKeys.detail('job-a')],
  ] as const)('reads the %s gallery and seeds each job into its detail entry', async (kind, url, job, detailKey) => {
    h.get.mockResolvedValue({ data: { data: [job], next_cursor: null } });
    const { result } = renderHook(() => useGenerationJobs(kind), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(h.get).toHaveBeenCalledWith(url, { params: { limit: GENERATION_GALLERY_PAGE_SIZE } });
    expect(queryClient.getQueryData(detailKey)).toEqual(job);
  });

  it("reads Studio's image gallery and pages it with the cursor", async () => {
    h.get
      .mockResolvedValueOnce({ data: { data: [studioImageJob({ id: 'a' })], next_cursor: 'c1' } })
      .mockResolvedValueOnce({ data: { data: [studioImageJob({ id: 'b' })], next_cursor: null } });
    const { result } = renderHook(() => useGenerationJobs('image'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(h.get).toHaveBeenCalledWith('/api/studio/image-jobs', { params: { limit: GENERATION_GALLERY_PAGE_SIZE } });
    expect(result.current.hasNextPage).toBe(true);
    await act(async () => {
      await result.current.fetchNextPage();
    });
    expect(h.get).toHaveBeenLastCalledWith('/api/studio/image-jobs', {
      params: { limit: GENERATION_GALLERY_PAGE_SIZE, cursor: 'c1' },
    });
  });

  it('polls the image gallery while the socket is down and a job is live', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    h.readyState = 3;
    h.get.mockResolvedValue({ data: { data: [studioImageJob()], next_cursor: null } });
    renderHook(() => useGenerationJobs('image'), { wrapper });
    await waitFor(() => expect(h.get).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SOCKET_DOWN_POLL_MS);
    });
    await waitFor(() => expect(h.get).toHaveBeenCalledTimes(2));
  });

  it('does not poll the image gallery while the socket is open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    h.get.mockResolvedValue({ data: { data: [studioImageJob()], next_cursor: null } });
    renderHook(() => useGenerationJobs('image'), { wrapper });
    await waitFor(() => expect(h.get).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SOCKET_DOWN_POLL_MS * 2);
    });
    expect(h.get).toHaveBeenCalledTimes(1);
  });
});

describe('useGenerationJob', () => {
  it('reads a chat image job from its own route', async () => {
    h.get.mockResolvedValue({ data: chatImageJob() });
    const { result } = renderHook(() => useGenerationJob('image', 'img-1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(h.get).toHaveBeenCalledWith('/api/image-jobs/img-1');
    expect(result.current.data?.state).toBe('running');
  });

  it('keeps a finished image job over a read taken before it finished', async () => {
    queryClient.setQueryData(chatImageJobKeys.detail('img-1'), chatImageJob({ state: 'succeeded' }));
    h.get.mockResolvedValue({ data: chatImageJob({ state: 'running', updated_at: '2026-11-01T00:01:00.000Z' }) });
    const { result } = renderHook(() => useGenerationJob('image', 'img-1'), { wrapper });
    await act(() => result.current.refetch());
    expect(queryClient.getQueryData<ChatImageJob>(chatImageJobKeys.detail('img-1'))?.state).toBe('succeeded');
  });

  it('never retries or reloads a missing (404) image job', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    h.get.mockRejectedValue(httpError(404));
    const { result } = renderHook(() => useGenerationJob('image', 'img-gone'), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ERRORED_RELOAD_MS * 2);
    });
    expect(h.get).toHaveBeenCalledTimes(1);
  });

  it('does not read an empty job id', async () => {
    renderHook(() => useGenerationJob('video', ''), { wrapper });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(h.get).not.toHaveBeenCalled();
  });
});

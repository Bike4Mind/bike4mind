// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: vi.fn() },
}));

import { api } from '@client/app/contexts/ApiContext';
import { useGeneratedMediaUrls } from './generatedMedia';

const createWrapper = (queryClient: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };

const newQueryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

const MINUTE_MS = 60 * 1000;
const respond = (urls: Record<string, string>, expiresInMs: number) => ({
  data: { urls, expiresAt: new Date(Date.now() + expiresInMs).toISOString() },
});

describe('useGeneratedMediaUrls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not fetch without keys or without a session id', () => {
    const queryClient = newQueryClient();
    const { result: noKeys } = renderHook(() => useGeneratedMediaUrls('session-1', []), {
      wrapper: createWrapper(queryClient),
    });
    const { result: noSession } = renderHook(() => useGeneratedMediaUrls(undefined, ['a.png']), {
      wrapper: createWrapper(queryClient),
    });

    expect(api.get).not.toHaveBeenCalled();
    expect(noKeys.current.urls).toEqual({});
    expect(noSession.current.urls).toEqual({});
  });

  it('requests sorted, de-duplicated keys with GET and returns the parsed url map', async () => {
    vi.mocked(api.get).mockResolvedValue(respond({ 'a.png': 'https://s3.test/a.png?sig=1' }, 60 * MINUTE_MS));
    const queryClient = newQueryClient();

    const { result } = renderHook(() => useGeneratedMediaUrls('session-1', ['b.png', 'a.png', 'b.png']), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.urls).toEqual({ 'a.png': 'https://s3.test/a.png?sig=1' }));
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.get).mock.calls[0][0]).toBe('/api/sessions/session-1/generated-media?keys=a.png&keys=b.png');
    expect(queryClient.getQueryCache().getAll()[0].queryKey).toEqual([
      'generatedMediaUrls',
      'session-1',
      ['a.png', 'b.png'],
    ]);
  });

  it('refetches under a new query key when a key arrives mid-stream', async () => {
    vi.mocked(api.get).mockResolvedValue(respond({}, 60 * MINUTE_MS));
    const queryClient = newQueryClient();

    const { rerender } = renderHook(({ keys }) => useGeneratedMediaUrls('session-1', keys), {
      initialProps: { keys: ['a.png'] },
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));

    rerender({ keys: ['a.png', 'b.mp4'] });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  });

  it('keeps the url of an already-held, still-fresh key while a new key gets its url', async () => {
    vi.mocked(api.get)
      .mockResolvedValueOnce(respond({ 'a.png': 'https://s3.test/a.png?sig=1' }, 60 * MINUTE_MS))
      .mockResolvedValueOnce(
        respond({ 'a.png': 'https://s3.test/a.png?sig=2', 'b.mp4': 'https://s3.test/b.mp4?sig=2' }, 60 * MINUTE_MS)
      );
    const queryClient = newQueryClient();

    const { result, rerender } = renderHook(({ keys }) => useGeneratedMediaUrls('session-1', keys), {
      initialProps: { keys: ['a.png'] },
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.urls).toEqual({ 'a.png': 'https://s3.test/a.png?sig=1' }));

    rerender({ keys: ['a.png', 'b.mp4'] });

    await waitFor(() =>
      expect(result.current.urls).toEqual({
        'a.png': 'https://s3.test/a.png?sig=1',
        'b.mp4': 'https://s3.test/b.mp4?sig=2',
      })
    );
  });

  it('replaces a held url that is within 15 minutes of expiry', async () => {
    vi.mocked(api.get)
      .mockResolvedValueOnce(respond({ 'a.png': 'https://s3.test/a.png?sig=1' }, 10 * MINUTE_MS))
      .mockResolvedValueOnce(
        respond({ 'a.png': 'https://s3.test/a.png?sig=2', 'b.mp4': 'https://s3.test/b.mp4?sig=2' }, 60 * MINUTE_MS)
      );
    const queryClient = newQueryClient();

    const { result, rerender } = renderHook(({ keys }) => useGeneratedMediaUrls('session-1', keys), {
      initialProps: { keys: ['a.png'] },
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.urls).toEqual({ 'a.png': 'https://s3.test/a.png?sig=1' }));

    rerender({ keys: ['a.png', 'b.mp4'] });

    await waitFor(() =>
      expect(result.current.urls).toEqual({
        'a.png': 'https://s3.test/a.png?sig=2',
        'b.mp4': 'https://s3.test/b.mp4?sig=2',
      })
    );
  });

  it('re-signs on the refresh interval, 15 minutes before expiry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.get)
      .mockResolvedValueOnce(respond({ 'a.png': 'https://s3.test/a.png?sig=1' }, 30 * MINUTE_MS))
      .mockResolvedValue(respond({ 'a.png': 'https://s3.test/a.png?sig=2' }, 60 * MINUTE_MS));
    const queryClient = newQueryClient();

    const { result } = renderHook(() => useGeneratedMediaUrls('session-1', ['a.png']), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.urls['a.png']).toBe('https://s3.test/a.png?sig=1'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(14 * MINUTE_MS);
    });
    expect(api.get).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * MINUTE_MS);
    });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    // The held url had only ~14 minutes left, so the re-signed one replaces it.
    await waitFor(() => expect(result.current.urls['a.png']).toBe('https://s3.test/a.png?sig=2'));
  });

  it('schedules the refresh off the earliest held expiry, not the newest response', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const startMs = Date.now();
    // Responses are built lazily so each expiresAt is absolute: startMs + the given minutes.
    const respondExpiringAt = (urls: Record<string, string>, minutesFromStart: number) =>
      respond(urls, startMs + minutesFromStart * MINUTE_MS - Date.now());
    vi.mocked(api.get)
      .mockImplementationOnce(async () => respondExpiringAt({ a: 'https://s3.test/a?sig=1' }, 60))
      .mockImplementationOnce(async () =>
        respondExpiringAt({ a: 'https://s3.test/a?sig=2', b: 'https://s3.test/b?sig=2' }, 80)
      )
      .mockImplementationOnce(async () =>
        respondExpiringAt({ a: 'https://s3.test/a?sig=3', b: 'https://s3.test/b?sig=3' }, 105)
      );
    const queryClient = newQueryClient();

    const { result, rerender } = renderHook(({ keys }) => useGeneratedMediaUrls('session-1', keys), {
      initialProps: { keys: ['a'] },
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.urls).toEqual({ a: 'https://s3.test/a?sig=1' }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20 * MINUTE_MS);
    });
    expect(api.get).toHaveBeenCalledTimes(1);

    rerender({ keys: ['a', 'b'] });
    await waitFor(() =>
      expect(result.current.urls).toEqual({ a: 'https://s3.test/a?sig=1', b: 'https://s3.test/b?sig=2' })
    );
    expect(api.get).toHaveBeenCalledTimes(2);

    // Refresh is due at T0+45min (a1's expiry minus 15), not T0+65min (newest response's expiry minus 15).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(24 * MINUTE_MS);
    });
    expect(api.get).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * MINUTE_MS);
    });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(3));
    // a1 had under 15 minutes left and is replaced; b2 still has more and is kept.
    await waitFor(() =>
      expect(result.current.urls).toEqual({ a: 'https://s3.test/a?sig=3', b: 'https://s3.test/b?sig=2' })
    );
  });
});

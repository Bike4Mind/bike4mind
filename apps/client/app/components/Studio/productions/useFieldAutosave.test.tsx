import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, type AxiosResponse } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultStudioTimeline, type StudioBrief } from '@bike4mind/common';

const h = vi.hoisted(() => ({ patch: vi.fn(), toastError: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: h.patch } }));
vi.mock('sonner', () => ({ toast: { error: h.toastError } }));

import { FIELD_AUTOSAVE_DELAY_MS, useFieldAutosave } from './useFieldAutosave';

const ID = 'c'.repeat(24);

const deferred = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise(res => {
    resolve = res;
  });
  return { promise, resolve };
};

const savedResponse = (brief: StudioBrief) => ({
  data: {
    composition: {
      id: ID,
      title: 'Spring ad',
      template: 'blank',
      brief,
      brandKit: { colors: [], productFileIds: [] },
      shots: [],
      timeline: { ...defaultStudioTimeline('blank'), tracks: [] },
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-01T10:00:00.000Z',
    },
  },
});

const unavailable = () =>
  new AxiosError('Unavailable', undefined, undefined, undefined, { status: 503, data: {} } as AxiosResponse);

const echo = async (_url: string, body: { brief: StudioBrief }) => savedResponse(body.brief);

const renderField = () => {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(() => useFieldAutosave(ID, 'brief', {}), { wrapper });
};

const sentSummaries = () => h.patch.mock.calls.map(([, body]: [string, { brief: StudioBrief }]) => body.brief.summary);
const elapse = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useFieldAutosave', () => {
  it('shows a waiting edit as pending, then saves it once', async () => {
    h.patch.mockImplementation(echo);
    const { result } = renderField();

    act(() => result.current.set({ summary: 'One' }));
    expect(result.current.status.kind).toBe('pending');
    await elapse(FIELD_AUTOSAVE_DELAY_MS - 1);
    expect(h.patch).not.toHaveBeenCalled();
    await elapse(1);
    expect(result.current.status.kind).toBe('saved');
    expect(sentSummaries()).toEqual(['One']);
  });

  it('sends a newer edit only after the save in flight lands', async () => {
    const first = deferred();
    h.patch.mockImplementationOnce(() => first.promise);
    h.patch.mockImplementation(echo);
    const { result } = renderField();

    act(() => result.current.set({ summary: 'One' }));
    await elapse(FIELD_AUTOSAVE_DELAY_MS);
    expect(h.patch).toHaveBeenCalledTimes(1);
    act(() => result.current.set({ summary: 'Two' }));
    await elapse(1_000);
    expect(h.patch).toHaveBeenCalledTimes(1);

    await act(async () => first.resolve(savedResponse({ summary: 'One' })));
    await elapse(0);
    expect(result.current.status.kind).toBe('saved');
    expect(sentSummaries()).toEqual(['One', 'Two']);
  });

  it('reports a failed save and sends the failed draft once more on unmount', async () => {
    h.patch.mockRejectedValueOnce(unavailable());
    h.patch.mockImplementation(echo);
    const { result, unmount } = renderField();

    act(() => result.current.set({ summary: 'One' }));
    await elapse(FIELD_AUTOSAVE_DELAY_MS);
    expect(result.current.status.kind).toBe('error');
    await elapse(1_000);
    expect(h.patch).toHaveBeenCalledTimes(1);

    unmount();
    await elapse(0);
    expect(h.patch).toHaveBeenCalledTimes(2);
    expect(sentSummaries()).toEqual(['One', 'One']);
  });

  it('sends an edit still inside the pause on unmount, and toasts if that save fails', async () => {
    h.patch.mockRejectedValue(unavailable());
    const { result, unmount } = renderField();

    act(() => result.current.set({ summary: 'Last' }));
    unmount();
    await elapse(0);
    expect(h.toastError).toHaveBeenCalledTimes(1);
    expect(sentSummaries()).toEqual(['Last']);
  });
});

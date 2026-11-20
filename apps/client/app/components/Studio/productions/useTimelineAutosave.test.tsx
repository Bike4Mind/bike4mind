import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, type AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultStudioTimeline, type StudioTimeline } from '@bike4mind/common';
import { addCaptionClip } from './timelineEdits';

const h = vi.hoisted(() => ({ patch: vi.fn(), toastError: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: h.patch } }));
vi.mock('sonner', () => ({ toast: { error: h.toastError } }));

import { useTimelineAutosave } from './useTimelineAutosave';

const ID = 'c'.repeat(24);
const CONTEXT = {};

const deferred = () => {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const savedResponse = (timeline: StudioTimeline) => ({
  data: {
    composition: {
      id: ID,
      title: 'Spring ad',
      template: 'blank',
      brief: {},
      brandKit: { colors: [], productFileIds: [] },
      shots: [],
      timeline,
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-01T10:00:00.000Z',
    },
  },
});

const unavailable = () =>
  new AxiosError('Unavailable', undefined, undefined, undefined, { status: 503, data: {} } as AxiosResponse);

const unprocessable = () =>
  new AxiosError('Unprocessable', undefined, undefined, undefined, {
    status: 422,
    data: {
      error: 'Invalid composition',
      issues: [{ code: 'unknown_file', path: ['tracks', 0, 'clips', 0, 'fileId'], message: 'No such file' }],
    },
  } as AxiosResponse);

const stored = { ...defaultStudioTimeline('blank'), tracks: [] };
const withCaption = (text: string) => addCaptionClip(stored, text).timeline;

const renderAutosave = () => {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(({ draft }: { draft: StudioTimeline }) => useTimelineAutosave(ID, draft, stored, CONTEXT), {
    wrapper,
    initialProps: { draft: stored },
  });
};

const sentTexts = () =>
  h.patch.mock.calls.map(([, body]: [string, { timeline: StudioTimeline }]) => {
    const track = body.timeline.tracks[0];
    return track?.kind === 'captions' ? track.clips[0].text : null;
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useTimelineAutosave', () => {
  it('saves a valid edit once after the pause and reports it saved', async () => {
    h.patch.mockImplementation(async (_url: string, body: { timeline: StudioTimeline }) =>
      savedResponse(body.timeline)
    );
    const { result, rerender } = renderAutosave();
    expect(result.current.status.kind).toBe('saved');

    rerender({ draft: withCaption('One') });
    expect(result.current.status.kind).toBe('pending');
    await act(() => new Promise(resolve => setTimeout(resolve, 400)));
    expect(h.patch).not.toHaveBeenCalled();

    await waitFor(() => expect(result.current.status.kind).toBe('saved'));
    expect(h.patch).toHaveBeenCalledTimes(1);
    expect(h.patch.mock.calls[0][0]).toBe(`/api/studio/compositions/${ID}`);
  });

  it('holds a newer edit until the save in flight lands, then sends the newer draft', async () => {
    const first = deferred();
    h.patch.mockImplementationOnce(() => first.promise);
    h.patch.mockImplementation(async (_url: string, body: { timeline: StudioTimeline }) =>
      savedResponse(body.timeline)
    );
    const { result, rerender } = renderAutosave();

    rerender({ draft: withCaption('One') });
    await waitFor(() => expect(h.patch).toHaveBeenCalledTimes(1));
    rerender({ draft: withCaption('Two') });
    await act(() => new Promise(resolve => setTimeout(resolve, 1_200)));
    expect(h.patch).toHaveBeenCalledTimes(1);

    await act(async () => first.resolve(savedResponse(withCaption('One'))));
    await waitFor(() => expect(h.patch).toHaveBeenCalledTimes(2));
    expect(sentTexts()).toEqual(['One', 'Two']);
    await waitFor(() => expect(result.current.status.kind).toBe('saved'));
  });

  it('sends a pending edit when the editor unmounts', async () => {
    h.patch.mockImplementation(async (_url: string, body: { timeline: StudioTimeline }) =>
      savedResponse(body.timeline)
    );
    const { rerender, unmount } = renderAutosave();
    rerender({ draft: withCaption('Leaving') });
    unmount();
    await waitFor(() => expect(h.patch).toHaveBeenCalledTimes(1));
    expect(sentTexts()).toEqual(['Leaving']);
  });

  it('shows the server issues of a rejected save and does not retry the same draft', async () => {
    h.patch.mockRejectedValue(unprocessable());
    const { result, rerender } = renderAutosave();
    rerender({ draft: withCaption('One') });

    await waitFor(() => expect(result.current.status.kind).toBe('error'));
    expect(result.current.status).toMatchObject({
      message: 'Invalid composition',
      issues: [{ code: 'unknown_file' }],
    });
    await act(() => new Promise(resolve => setTimeout(resolve, 1_200)));
    expect(h.patch).toHaveBeenCalledTimes(1);
  });

  it('retries a save that failed for a transient reason once on unmount', async () => {
    h.patch.mockRejectedValueOnce(unavailable());
    h.patch.mockImplementation(async (_url: string, body: { timeline: StudioTimeline }) =>
      savedResponse(body.timeline)
    );
    const { result, rerender, unmount } = renderAutosave();
    rerender({ draft: withCaption('Flaky') });
    await waitFor(() => expect(result.current.status.kind).toBe('error'));
    expect(result.current.blocksNavigation).toBe(false);

    unmount();
    await waitFor(() => expect(h.patch).toHaveBeenCalledTimes(2));
    expect(sentTexts()).toEqual(['Flaky', 'Flaky']);
  });

  it('blocks navigation, and does not resend on unmount, after the server rejects a draft', async () => {
    h.patch.mockRejectedValue(unprocessable());
    const { result, rerender, unmount } = renderAutosave();
    rerender({ draft: withCaption('Rejected') });
    await waitFor(() => expect(result.current.status.kind).toBe('error'));
    expect(result.current.blocksNavigation).toBe(true);

    unmount();
    await act(() => new Promise(resolve => setTimeout(resolve, 200)));
    expect(h.patch).toHaveBeenCalledTimes(1);
  });

  it('does not save a draft the validator rejects, even on unmount', async () => {
    const overlapping = addCaptionClip(withCaption('One'), 'Two').timeline;
    const track = overlapping.tracks[0];
    if (track.kind !== 'captions') throw new Error('expected a captions track');
    track.clips[1] = { ...track.clips[1], startMs: 1_000 };
    const { result, rerender, unmount } = renderAutosave();

    rerender({ draft: overlapping });
    expect(result.current.status.kind).toBe('invalid');
    expect(result.current.blocksNavigation).toBe(true);
    unmount();
    await act(() => new Promise(resolve => setTimeout(resolve, 1_000)));
    expect(h.patch).not.toHaveBeenCalled();
  });
});

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioImageJob } from '@client/app/hooks/data/studioImageJobs';

const h = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  jobs: [] as StudioImageJob[],
  listFor: undefined as StudioImageJob[] | undefined,
  list: undefined as unknown,
}));
vi.mock('@client/app/hooks/data/studioImageJobs', () => ({
  useCreateStudioImageCutout: () => ({ mutateAsync: h.mutateAsync }),
  // Stable per h.jobs, as React Query's data is per fetch, so the hook sees a new list only when the jobs change.
  useStudioImageJobs: () => {
    if (h.listFor !== h.jobs) h.list = { pages: [{ data: h.jobs, next_cursor: null }] };
    h.listFor = h.jobs;
    return { data: h.list };
  },
  describeStudioImageCutoutError: () => 'Remove background works on PNG or JPEG images',
}));

import { useReferenceCutouts } from './useReferenceCutouts';

const cutoutJob = (patch: Partial<StudioImageJob>): StudioImageJob => ({
  id: 'job-1',
  groupId: 'job-1',
  purpose: 'cutout',
  state: 'pending',
  request: { model: 'gpt-image-1.5', mode: 'edit', prompt: 'cut out' } as StudioImageJob['request'],
  error: null,
  output: null,
  createdAt: '2026-11-12T00:00:00.000Z',
  ...patch,
});

describe('useReferenceCutouts', () => {
  beforeEach(() => {
    h.mutateAsync.mockReset();
    h.jobs = [];
  });

  it('starts a cutout job and follows it to the saved file', async () => {
    h.mutateAsync.mockResolvedValue(cutoutJob({}));
    const { result, rerender } = renderHook(() => useReferenceCutouts());

    act(() => result.current.toggleCutout('file-1', true));
    expect(h.mutateAsync).toHaveBeenCalledWith('file-1');
    expect(result.current.cutoutOf('file-1')).toEqual({ status: 'pending' });

    h.jobs = [cutoutJob({ state: 'succeeded', output: { fileId: 'cutout-1', contentType: 'image/png', bytes: 1 } })];
    rerender();
    await waitFor(() => expect(result.current.cutoutOf('file-1')).toEqual({ status: 'ready', fileId: 'cutout-1' }));
  });

  it('keeps a ready cutout once its job drops out of the loaded gallery pages', async () => {
    h.mutateAsync.mockResolvedValue(cutoutJob({}));
    const { result, rerender } = renderHook(() => useReferenceCutouts());
    await act(async () => result.current.toggleCutout('file-1', true));

    h.jobs = [cutoutJob({ state: 'succeeded', output: { fileId: 'cutout-1', contentType: 'image/png', bytes: 1 } })];
    rerender();
    await waitFor(() => expect(result.current.cutoutOf('file-1')).toEqual({ status: 'ready', fileId: 'cutout-1' }));

    h.jobs = [];
    rerender();
    expect(result.current.cutoutOf('file-1')).toEqual({ status: 'ready', fileId: 'cutout-1' });
  });

  it('shows a refused create as failed', async () => {
    h.mutateAsync.mockRejectedValue(new Error('422'));
    const { result } = renderHook(() => useReferenceCutouts());

    act(() => result.current.toggleCutout('file-1', true));
    await waitFor(() =>
      expect(result.current.cutoutOf('file-1')).toEqual({
        status: 'failed',
        message: 'Remove background works on PNG or JPEG images',
      })
    );
  });

  it('hides a cutout turned off before its reply arrived, and reuses that job when turned back on', async () => {
    let resolve: (job: StudioImageJob) => void = () => {};
    h.mutateAsync.mockReturnValue(new Promise<StudioImageJob>(done => (resolve = done)));
    const { result } = renderHook(() => useReferenceCutouts());

    act(() => result.current.toggleCutout('file-1', true));
    act(() => result.current.toggleCutout('file-1', false));
    await act(async () => resolve(cutoutJob({})));
    expect(result.current.cutoutOf('file-1')).toBeUndefined();

    act(() => result.current.toggleCutout('file-1', true));
    expect(result.current.cutoutOf('file-1')).toEqual({ status: 'pending' });
    expect(h.mutateAsync).toHaveBeenCalledTimes(1);
  });

  it('reuses a ready cutout when the switch is flipped off and on, without charging again', async () => {
    h.mutateAsync.mockResolvedValue(cutoutJob({}));
    const { result, rerender } = renderHook(() => useReferenceCutouts());
    await act(async () => result.current.toggleCutout('file-1', true));
    h.jobs = [cutoutJob({ state: 'succeeded', output: { fileId: 'cutout-1', contentType: 'image/png', bytes: 1 } })];
    rerender();
    await waitFor(() => expect(result.current.cutoutOf('file-1')).toEqual({ status: 'ready', fileId: 'cutout-1' }));

    act(() => result.current.toggleCutout('file-1', false));
    expect(result.current.cutoutOf('file-1')).toBeUndefined();
    act(() => result.current.toggleCutout('file-1', true));

    expect(result.current.cutoutOf('file-1')).toEqual({ status: 'ready', fileId: 'cutout-1' });
    expect(h.mutateAsync).toHaveBeenCalledTimes(1);
  });

  it('retries a failed cutout when it is turned back on', async () => {
    h.mutateAsync.mockRejectedValueOnce(new Error('422')).mockResolvedValueOnce(cutoutJob({}));
    const { result } = renderHook(() => useReferenceCutouts());
    act(() => result.current.toggleCutout('file-1', true));
    await waitFor(() => expect(result.current.cutoutOf('file-1')?.status).toBe('failed'));

    act(() => result.current.toggleCutout('file-1', false));
    act(() => result.current.toggleCutout('file-1', true));

    expect(h.mutateAsync).toHaveBeenCalledTimes(2);
    expect(result.current.cutoutOf('file-1')).toEqual({ status: 'pending' });
  });
});

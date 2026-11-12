import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioImageJob } from '@client/app/hooks/data/studioImageJobs';

const h = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  jobs: [] as StudioImageJob[],
}));
vi.mock('@client/app/hooks/data/studioImageJobs', () => ({
  useCreateStudioImageCutout: () => ({ mutateAsync: h.mutateAsync }),
  useStudioImageJobs: () => ({ data: { pages: [{ data: h.jobs, next_cursor: null }] } }),
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

  it('drops the reply for a cutout turned off before it arrived', async () => {
    let resolve: (job: StudioImageJob) => void = () => {};
    h.mutateAsync.mockReturnValue(new Promise<StudioImageJob>(done => (resolve = done)));
    const { result } = renderHook(() => useReferenceCutouts());

    act(() => result.current.toggleCutout('file-1', true));
    act(() => result.current.toggleCutout('file-1', false));
    await act(async () => resolve(cutoutJob({})));
    expect(result.current.cutoutOf('file-1')).toBeUndefined();
  });
});

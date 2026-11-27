import { describe, expect, it, vi } from 'vitest';
import type { StudioImageJob } from '@client/app/hooks/data/studioImageJobs';
import { referenceCutoutProblem, referenceFileIdToSend, resolveCutout } from './referenceCutouts';

const job = (patch: Partial<StudioImageJob>): StudioImageJob => ({
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

const started = { status: 'started', jobId: 'job-1' } as const;

describe('resolveCutout', () => {
  it('is pending while the create is in flight, the job is not listed yet, or it is live', () => {
    expect(resolveCutout({ status: 'starting', attempt: 1 }, undefined)).toEqual({ status: 'pending' });
    expect(resolveCutout(started, undefined)).toEqual({ status: 'pending' });
    expect(resolveCutout(started, job({ state: 'running' }))).toEqual({ status: 'pending' });
  });

  it('stays pending when a socket frame marks it succeeded before the refetch brings its output', () => {
    expect(resolveCutout(started, job({ state: 'succeeded' }))).toEqual({ status: 'pending' });
  });

  it('is ready with the cutout file once saved to Files', () => {
    const output = { fileId: 'cutout-1', contentType: 'image/png', bytes: 10 };
    expect(resolveCutout(started, job({ state: 'succeeded', output }))).toEqual({
      status: 'ready',
      fileId: 'cutout-1',
    });
  });

  it('fails with the refusal, the job error, or the Files fallback', () => {
    expect(resolveCutout({ status: 'refused', message: 'Not enough credits' }, undefined)).toEqual({
      status: 'failed',
      message: 'Not enough credits',
    });
    const error = { code: 'provider_error', message: 'The provider failed to generate the image.' };
    expect(resolveCutout(started, job({ state: 'failed', error }))).toEqual({
      status: 'failed',
      message: error.message,
    });
    const unsaved = job({ state: 'succeeded', output: { fileId: null, contentType: 'image/png', bytes: 10 } });
    expect(resolveCutout(started, unsaved)).toMatchObject({ status: 'failed' });
  });
});

describe('referenceFileIdToSend', () => {
  it('sends the cutout only once ready', () => {
    expect(referenceFileIdToSend({ fileId: 'a', fileName: 'a.png' })).toBe('a');
    expect(referenceFileIdToSend({ fileId: 'a', fileName: 'a.png', cutout: { status: 'pending' } })).toBe('a');
    expect(referenceFileIdToSend({ fileId: 'a', fileName: 'a.png', cutout: { status: 'ready', fileId: 'c' } })).toBe(
      'c'
    );
  });
});

describe('referenceCutoutProblem', () => {
  it('is null when every cutout is ready or off', () => {
    const files = [
      { fileId: 'a', fileName: 'a.png' },
      { fileId: 'b', fileName: 'b.png', cutout: { status: 'ready', fileId: 'c' } as const },
    ];
    expect(referenceCutoutProblem(files, vi.fn())).toBeNull();
  });

  it('puts a failure first, with a fix that turns that cutout off', () => {
    const toggle = vi.fn();
    const problem = referenceCutoutProblem(
      [
        { fileId: 'a', fileName: 'a.png', cutout: { status: 'pending' } },
        { fileId: 'b', fileName: 'b.png', cutout: { status: 'failed', message: 'boom' } },
      ],
      toggle
    );
    expect(problem?.invalidReason).toBe('b.png: boom');
    problem?.fix?.apply();
    expect(toggle).toHaveBeenCalledWith('b', false);
  });
});

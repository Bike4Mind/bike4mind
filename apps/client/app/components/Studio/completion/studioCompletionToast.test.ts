import { describe, expect, it } from 'vitest';
import type { StudioJobCompletion } from '@bike4mind/common';
import { describeStudioCompletion } from './studioCompletionToast';

const completion = (overrides: Partial<StudioJobCompletion>): StudioJobCompletion => ({
  version: 1,
  groupId: 'g1',
  medium: 'image',
  totalCount: 4,
  readyCount: 4,
  failedCount: 0,
  cancelledCount: 0,
  title: 'Cold brew launch',
  link: '/studio/image?group=g1',
  completedAt: '2026-11-12T10:00:00.000Z',
  ...overrides,
});

describe('describeStudioCompletion', () => {
  it('announces a group whose takes all succeeded', () => {
    expect(describeStudioCompletion(completion({}))).toEqual({
      tone: 'success',
      message: '4 takes ready, Cold brew launch',
    });
  });

  it('uses the singular for one take', () => {
    expect(describeStudioCompletion(completion({ totalCount: 1, readyCount: 1 })).message).toBe(
      '1 take ready, Cold brew launch'
    );
  });

  it('warns on a partial failure', () => {
    expect(describeStudioCompletion(completion({ readyCount: 3, failedCount: 1 }))).toEqual({
      tone: 'warning',
      message: '3 of 4 takes ready, Cold brew launch',
      description: '1 failed',
    });
  });

  it('reports a group whose takes all failed', () => {
    expect(describeStudioCompletion(completion({ readyCount: 0, failedCount: 4 }))).toEqual({
      tone: 'error',
      message: '4 takes failed, Cold brew launch',
    });
  });

  it('leaves cancelled takes out of the counts', () => {
    expect(describeStudioCompletion(completion({ readyCount: 2, failedCount: 1, cancelledCount: 1 })).message).toBe(
      '2 of 3 takes ready, Cold brew launch'
    );
  });

  it('names a single-output medium', () => {
    const video = completion({ medium: 'video', totalCount: 1, readyCount: 1, title: 'Lighthouse' });
    expect(describeStudioCompletion(video)).toEqual({ tone: 'success', message: 'Video ready, Lighthouse' });
    expect(describeStudioCompletion({ ...video, medium: 'music', readyCount: 0, failedCount: 1 })).toEqual({
      tone: 'error',
      message: 'Track failed, Lighthouse',
    });
  });
});

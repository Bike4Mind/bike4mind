import { QueryClient } from '@tanstack/react-query';
import type { VideoGeneration } from '@bike4mind/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { listOf, videoJob } from './__test__/videoGenerationFixtures';
import {
  isTerminalVideoState,
  patchVideoGeneration,
  prependVideoGeneration,
  seedVideoGeneration,
  shouldReplaceVideoGeneration,
  upsertVideoGeneration,
  type VideoGenerationList,
} from './videoGenerationCache';
import { videoGenerationKeys } from './videoGenerationKeys';

const LATER = '2026-10-07T00:01:00.000Z';
let queryClient: QueryClient;

const detail = (id: string) => queryClient.getQueryData<VideoGeneration>(videoGenerationKeys.detail(id));
const listIds = () =>
  queryClient.getQueryData<VideoGenerationList>(videoGenerationKeys.list)?.pages.map(page => page.data.map(j => j.id));
const listJob = (id: string) =>
  queryClient
    .getQueryData<VideoGenerationList>(videoGenerationKeys.list)
    ?.pages.flatMap(page => page.data)
    .find(job => job.id === id);

beforeEach(() => {
  queryClient = new QueryClient();
});

describe('isTerminalVideoState', () => {
  it.each(['succeeded', 'failed', 'blocked', 'cancelled'] as const)('%s is terminal', state => {
    expect(isTerminalVideoState(state)).toBe(true);
  });
  it.each(['pending', 'running', 'storing'] as const)('%s is not', state => {
    expect(isTerminalVideoState(state)).toBe(false);
  });
});

describe('shouldReplaceVideoGeneration', () => {
  it('replaces when nothing is cached', () => {
    expect(shouldReplaceVideoGeneration(undefined, videoJob())).toBe(true);
  });
  it('replaces with a newer or equally new snapshot', () => {
    expect(shouldReplaceVideoGeneration(videoJob(), videoJob({ updated_at: LATER }))).toBe(true);
    expect(shouldReplaceVideoGeneration(videoJob(), videoJob())).toBe(true);
  });
  it('keeps the cached job when the incoming one is older', () => {
    expect(shouldReplaceVideoGeneration(videoJob({ updated_at: LATER }), videoJob())).toBe(false);
  });
  it('keeps a storing job when a same-timestamp row says running, and takes a forward one', () => {
    expect(shouldReplaceVideoGeneration(videoJob({ state: 'storing' }), videoJob({ state: 'running' }))).toBe(false);
    expect(shouldReplaceVideoGeneration(videoJob({ state: 'running' }), videoJob({ state: 'storing' }))).toBe(true);
  });
  it('never replaces a terminal job with a non-terminal one', () => {
    const cached = videoJob({ state: 'succeeded' });
    expect(shouldReplaceVideoGeneration(cached, videoJob({ state: 'running', updated_at: LATER }))).toBe(false);
  });
});

describe('seedVideoGeneration', () => {
  it('writes a listed job into its detail entry', () => {
    seedVideoGeneration(queryClient, videoJob());
    expect(detail('job-1')).toEqual(videoJob());
  });

  it('does not overwrite a newer cached job with an older list row', () => {
    queryClient.setQueryData(videoGenerationKeys.detail('job-1'), videoJob({ state: 'storing', updated_at: LATER }));
    seedVideoGeneration(queryClient, videoJob({ state: 'running' }));
    expect(detail('job-1')?.state).toBe('storing');
  });
});

describe('prependVideoGeneration', () => {
  it('puts a new job at the top of the first page and seeds its detail', () => {
    queryClient.setQueryData(videoGenerationKeys.list, listOf([videoJob({ id: 'old' })], [videoJob({ id: 'older' })]));
    prependVideoGeneration(queryClient, videoJob({ id: 'new' }));
    expect(listIds()).toEqual([['new', 'old'], ['older']]);
    expect(detail('new')?.id).toBe('new');
  });

  it('does not duplicate a replayed job already on the first page', () => {
    queryClient.setQueryData(videoGenerationKeys.list, listOf([videoJob({ id: 'a' }), videoJob({ id: 'b' })]));
    prependVideoGeneration(queryClient, videoJob({ id: 'b' }));
    expect(listIds()).toEqual([['b', 'a']]);
  });

  it('does not overwrite a newer detail with a stale create response', () => {
    queryClient.setQueryData(
      videoGenerationKeys.detail('new'),
      videoJob({ id: 'new', state: 'running', updated_at: LATER })
    );
    prependVideoGeneration(queryClient, videoJob({ id: 'new', state: 'pending' }));
    expect(detail('new')?.state).toBe('running');
  });

  it('leaves an unloaded list alone', () => {
    prependVideoGeneration(queryClient, videoJob({ id: 'new' }));
    expect(queryClient.getQueryData(videoGenerationKeys.list)).toBeUndefined();
  });
});

describe('upsertVideoGeneration', () => {
  it('replaces the detail and the list row with the server response', () => {
    queryClient.setQueryData(videoGenerationKeys.list, listOf([videoJob()]));
    upsertVideoGeneration(queryClient, videoJob({ state: 'cancelled', updated_at: LATER }));
    expect(detail('job-1')?.state).toBe('cancelled');
    expect(listJob('job-1')?.state).toBe('cancelled');
  });

  it.each([LATER, '2026-10-07T00:00:30.000Z'])(
    'ignores a late cancel response that is older than the cached cancelled job (incoming %s)',
    incomingUpdatedAt => {
      const cancelled = videoJob({ state: 'cancelled', updated_at: LATER });
      queryClient.setQueryData(videoGenerationKeys.detail('job-1'), cancelled);
      queryClient.setQueryData(videoGenerationKeys.list, listOf([cancelled]));
      upsertVideoGeneration(queryClient, videoJob({ state: 'running', updated_at: incomingUpdatedAt }));
      expect(detail('job-1')?.state).toBe('cancelled');
      expect(listJob('job-1')?.state).toBe('cancelled');
    }
  );

  it('prepends a job that is not cached yet', () => {
    queryClient.setQueryData(videoGenerationKeys.list, listOf([videoJob({ id: 'other' })]));
    upsertVideoGeneration(queryClient, videoJob());
    expect(listIds()).toEqual([['job-1', 'other']]);
    expect(detail('job-1')?.id).toBe('job-1');
  });
});

describe('patchVideoGeneration', () => {
  it('patches state and progress into the detail and the list row', () => {
    queryClient.setQueryData(videoGenerationKeys.detail('job-1'), videoJob());
    queryClient.setQueryData(videoGenerationKeys.list, listOf([videoJob()]));
    const found = patchVideoGeneration(queryClient, { id: 'job-1', state: 'running', progress: 0.4 });
    expect(found).toBe(true);
    expect(detail('job-1')).toMatchObject({ state: 'running', progress: 0.4 });
    expect(listJob('job-1')).toMatchObject({ state: 'running', progress: 0.4 });
  });

  it('keeps the last progress when a frame omits it', () => {
    queryClient.setQueryData(videoGenerationKeys.detail('job-1'), videoJob({ progress: 0.7 }));
    patchVideoGeneration(queryClient, { id: 'job-1', state: 'storing' });
    expect(detail('job-1')).toMatchObject({ state: 'storing', progress: 0.7 });
  });

  it('never regresses a terminal job', () => {
    queryClient.setQueryData(videoGenerationKeys.detail('job-1'), videoJob({ state: 'succeeded' }));
    queryClient.setQueryData(videoGenerationKeys.list, listOf([videoJob({ state: 'succeeded' })]));
    patchVideoGeneration(queryClient, { id: 'job-1', state: 'running', progress: 0.9 });
    expect(detail('job-1')?.state).toBe('succeeded');
    expect(listJob('job-1')?.state).toBe('succeeded');
  });

  it('ignores a backwards frame but applies a forward one', () => {
    queryClient.setQueryData(videoGenerationKeys.detail('job-1'), videoJob({ state: 'storing' }));
    queryClient.setQueryData(videoGenerationKeys.list, listOf([videoJob({ state: 'storing' })]));
    patchVideoGeneration(queryClient, { id: 'job-1', state: 'running', progress: 0.1 });
    expect(detail('job-1')?.state).toBe('storing');
    expect(listJob('job-1')?.state).toBe('storing');
    expect(detail('job-1')?.progress).toBeNull();

    queryClient.setQueryData(videoGenerationKeys.detail('job-1'), videoJob({ state: 'running' }));
    queryClient.setQueryData(videoGenerationKeys.list, listOf([videoJob({ state: 'running' })]));
    patchVideoGeneration(queryClient, { id: 'job-1', state: 'storing' });
    expect(detail('job-1')?.state).toBe('storing');
    expect(listJob('job-1')?.state).toBe('storing');
  });

  it('reports a job it has never seen', () => {
    queryClient.setQueryData(videoGenerationKeys.list, listOf([videoJob()]));
    expect(patchVideoGeneration(queryClient, { id: 'elsewhere', state: 'pending' })).toBe(false);
  });
});

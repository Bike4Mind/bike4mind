import { QueryClient } from '@tanstack/react-query';
import type { MusicGeneration } from '@bike4mind/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { musicJob } from './__test__/musicGenerationFixtures';
import {
  patchMusicGeneration,
  prependMusicGeneration,
  reconcileFetchedMusicGeneration,
  seedMusicGeneration,
  upsertMusicGeneration,
  type MusicGenerationList,
} from './musicGenerationCache';
import { musicGenerationKeys } from './musicGenerationKeys';

const LATER = '2026-10-07T00:01:00.000Z';
let queryClient: QueryClient;

const detail = (id = 'music-1') => queryClient.getQueryData<MusicGeneration>(musicGenerationKeys.detail(id));

beforeEach(() => {
  queryClient = new QueryClient();
});

describe('musicGenerationKeys', () => {
  it('nests every detail under details and all', () => {
    expect(musicGenerationKeys.detail('x').slice(0, 2)).toEqual(musicGenerationKeys.details);
    expect(musicGenerationKeys.details.slice(0, 1)).toEqual(musicGenerationKeys.all);
  });
});

describe('patchMusicGeneration', () => {
  it('reports an uncached job and writes nothing', () => {
    expect(patchMusicGeneration(queryClient, { id: 'music-1', state: 'running' })).toBe(false);
    expect(detail()).toBeUndefined();
  });

  it('applies a forward state', () => {
    queryClient.setQueryData(musicGenerationKeys.detail('music-1'), musicJob({ state: 'pending' }));
    expect(patchMusicGeneration(queryClient, { id: 'music-1', state: 'storing' })).toBe(true);
    expect(detail()?.state).toBe('storing');
  });

  it('never steps a live job backwards', () => {
    queryClient.setQueryData(musicGenerationKeys.detail('music-1'), musicJob({ state: 'storing' }));
    patchMusicGeneration(queryClient, { id: 'music-1', state: 'running' });
    expect(detail()?.state).toBe('storing');
  });

  it('never reopens a terminal job', () => {
    queryClient.setQueryData(musicGenerationKeys.detail('music-1'), musicJob({ state: 'cancelled' }));
    expect(patchMusicGeneration(queryClient, { id: 'music-1', state: 'running' })).toBe(true);
    expect(detail()?.state).toBe('cancelled');
  });
});

describe('upsertMusicGeneration', () => {
  it('writes an uncached job', () => {
    upsertMusicGeneration(queryClient, musicJob());
    expect(detail()).toBeDefined();
  });

  it('keeps a newer cached job over an older response', () => {
    queryClient.setQueryData(musicGenerationKeys.detail('music-1'), musicJob({ updated_at: LATER, state: 'storing' }));
    upsertMusicGeneration(queryClient, musicJob());
    expect(detail()?.state).toBe('storing');
  });

  it('never replaces a terminal job with a live one', () => {
    queryClient.setQueryData(musicGenerationKeys.detail('music-1'), musicJob({ state: 'cancelled' }));
    upsertMusicGeneration(queryClient, musicJob({ state: 'running', updated_at: LATER }));
    expect(detail()?.state).toBe('cancelled');
  });
});

// The card read 'Cancelling' after the song had finished: the websocket frame wrote 'succeeded' (keeping the cached
// updated_at), then a response read before it - but stamped later - arrived and was written over it.
describe('a cancel racing the job to completion', () => {
  const cancelResponse = () => musicJob({ state: 'running', updated_at: LATER });

  it('keeps the finished job when the cancel response lands after the success frame', () => {
    queryClient.setQueryData(musicGenerationKeys.detail('music-1'), musicJob({ state: 'running' }));
    patchMusicGeneration(queryClient, { id: 'music-1', state: 'succeeded' });
    upsertMusicGeneration(queryClient, cancelResponse());
    expect(detail()?.state).toBe('succeeded');
  });

  it('keeps the finished job when a detail refetch read before the success frame lands after it', () => {
    queryClient.setQueryData(musicGenerationKeys.detail('music-1'), musicJob({ state: 'running' }));
    patchMusicGeneration(queryClient, { id: 'music-1', state: 'succeeded' });
    expect(reconcileFetchedMusicGeneration(queryClient, cancelResponse()).state).toBe('succeeded');
  });

  it('keeps a storing job when the cancel response, read while it ran, lands after the storing frame', () => {
    queryClient.setQueryData(musicGenerationKeys.detail('music-1'), musicJob({ state: 'running' }));
    patchMusicGeneration(queryClient, { id: 'music-1', state: 'storing' });
    upsertMusicGeneration(queryClient, cancelResponse());
    expect(detail()?.state).toBe('storing');
  });
});

describe('music gallery list', () => {
  const listOf = (...jobs: MusicGeneration[]): MusicGenerationList => ({
    pages: [{ data: jobs, next_cursor: null }],
    pageParams: [undefined],
  });
  const listed = () => queryClient.getQueryData<MusicGenerationList>(musicGenerationKeys.list)?.pages[0].data;

  it('patches a listed job that has no detail entry, and reports it as cached', () => {
    queryClient.setQueryData(musicGenerationKeys.list, listOf(musicJob({ state: 'pending' })));
    expect(patchMusicGeneration(queryClient, { id: 'music-1', state: 'running' })).toBe(true);
    expect(listed()?.[0].state).toBe('running');
  });

  it('prepends a created job once, even when the create is replayed', () => {
    queryClient.setQueryData(musicGenerationKeys.list, listOf(musicJob({ id: 'old' })));
    prependMusicGeneration(queryClient, musicJob({ id: 'new' }));
    prependMusicGeneration(queryClient, musicJob({ id: 'new' }));
    expect(listed()?.map(job => job.id)).toEqual(['new', 'old']);
    expect(detail('new')?.id).toBe('new');
  });

  it('refetches, rather than writes, a list that has not loaded', () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    prependMusicGeneration(queryClient, musicJob({ id: 'new' }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: musicGenerationKeys.list });
    expect(queryClient.getQueryData(musicGenerationKeys.list)).toBeUndefined();
  });

  it('seeds a listed job into its detail entry unless the cache holds a newer one', () => {
    seedMusicGeneration(queryClient, musicJob({ state: 'succeeded', updated_at: LATER }));
    seedMusicGeneration(queryClient, musicJob({ state: 'running' }));
    expect(detail()?.state).toBe('succeeded');
  });
});

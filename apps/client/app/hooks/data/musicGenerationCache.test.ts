import { QueryClient } from '@tanstack/react-query';
import type { MusicGeneration } from '@bike4mind/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { musicJob } from './__test__/musicGenerationFixtures';
import { patchMusicGeneration, upsertMusicGeneration } from './musicGenerationCache';
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

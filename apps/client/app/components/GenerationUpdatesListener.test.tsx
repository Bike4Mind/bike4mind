import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IGenerationJobUpdatedAction, MusicGeneration, VideoGeneration } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  readyState: 1,
  handlers: [] as ((message: unknown) => Promise<void>)[],
}));

vi.mock('@client/app/contexts/WebsocketContext', () => ({
  ReadyState: { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
  useWebsocket: () => ({
    readyState: h.readyState,
    subscribeToAction: (_action: string, callback: (message: unknown) => Promise<void>) => {
      h.handlers.push(callback);
      return () => {
        h.handlers = h.handlers.filter(entry => entry !== callback);
      };
    },
  }),
}));

import { listOf, readyOutput, videoJob } from '@client/app/hooks/data/__test__/videoGenerationFixtures';
import { musicJob, musicOutput } from '@client/app/hooks/data/__test__/musicGenerationFixtures';
import { musicGenerationKeys } from '@client/app/hooks/data/musicGenerationKeys';
import { videoGenerationKeys } from '@client/app/hooks/data/videoGenerationKeys';
import GenerationUpdatesListener from './GenerationUpdatesListener';

let queryClient: QueryClient;

const renderListener = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <GenerationUpdatesListener />
    </QueryClientProvider>
  );

const frame = (job: IGenerationJobUpdatedAction['job']): IGenerationJobUpdatedAction => ({
  action: 'generation_job_updated',
  job,
});

const send = async (message: IGenerationJobUpdatedAction) => {
  await act(async () => {
    await Promise.all(h.handlers.map(handler => handler(message)));
  });
};

const musicDetail = (id: string) => queryClient.getQueryData<MusicGeneration>(musicGenerationKeys.detail(id));
const detail = (id: string) => queryClient.getQueryData<VideoGeneration>(videoGenerationKeys.detail(id));

beforeEach(() => {
  h.readyState = 1;
  h.handlers = [];
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

describe('GenerationUpdatesListener', () => {
  it('patches a running frame into the job', async () => {
    queryClient.setQueryData(videoGenerationKeys.detail('job-1'), videoJob({ state: 'pending' }));
    renderListener();
    await send(frame({ id: 'job-1', kind: 'video', state: 'running', progress: 0.25 }));
    expect(detail('job-1')).toMatchObject({ state: 'running', progress: 0.25 });
  });

  it('refetches a finished job and the credit balance instead of trusting the frame', async () => {
    queryClient.setQueryData(videoGenerationKeys.detail('job-1'), videoJob({ state: 'running' }));
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    renderListener();
    await send(
      frame({
        id: 'job-1',
        kind: 'video',
        state: 'failed',
        error: { code: 'orphaned_submit', message: 'raw provider text' },
      })
    );
    expect(detail('job-1')).toMatchObject({ state: 'failed', error: null });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: videoGenerationKeys.detail('job-1'),
      exact: true,
      refetchType: 'all',
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['credits-balance'] });
  });

  it('refreshes the gallery for a job started elsewhere', async () => {
    queryClient.setQueryData(videoGenerationKeys.list, listOf([videoJob()]));
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    renderListener();
    await send(frame({ id: 'from-the-api', kind: 'video', state: 'pending' }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: videoGenerationKeys.list });
  });

  it('ignores a frame for an unknown kind of job', async () => {
    queryClient.setQueryData(videoGenerationKeys.detail('job-1'), videoJob({ state: 'pending' }));
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    renderListener();
    await send(frame({ id: 'job-1', kind: 'hologram', state: 'running' } as never));
    expect(detail('job-1')?.state).toBe('pending');
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('ignores other actions', async () => {
    queryClient.setQueryData(videoGenerationKeys.detail('job-1'), videoJob({ state: 'pending' }));
    renderListener();
    await act(async () => {
      await Promise.all(h.handlers.map(handler => handler({ action: 'invalidate_query', queryKey: ['x'] })));
    });
    expect(detail('job-1')?.state).toBe('pending');
  });

  it('on reconnect refreshes the list, the unfinished jobs and the ones still waiting for output, once', async () => {
    queryClient.setQueryData(videoGenerationKeys.detail('live'), videoJob({ id: 'live', state: 'running' }));
    queryClient.setQueryData(
      videoGenerationKeys.detail('done'),
      videoJob({ id: 'done', state: 'succeeded', output: readyOutput() })
    );
    queryClient.setQueryData(
      videoGenerationKeys.detail('no-output'),
      videoJob({ id: 'no-output', state: 'succeeded', output: null })
    );
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { rerender } = renderListener();
    // A fresh element each time: re-rendering the same element reference bails out before the mock is re-read.
    const tree = () => (
      <QueryClientProvider client={queryClient}>
        <GenerationUpdatesListener />
      </QueryClientProvider>
    );

    // The first connect has nothing to catch up on.
    expect(invalidate).not.toHaveBeenCalled();

    h.readyState = 3;
    rerender(tree());
    h.readyState = 1;
    rerender(tree());

    expect(invalidate).toHaveBeenCalledWith({ queryKey: videoGenerationKeys.list });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: videoGenerationKeys.detail('live'),
      exact: true,
      refetchType: 'all',
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: videoGenerationKeys.detail('no-output'),
      exact: true,
      refetchType: 'all',
    });
    expect(invalidate).not.toHaveBeenCalledWith({
      queryKey: videoGenerationKeys.detail('done'),
      exact: true,
      refetchType: 'all',
    });
    // The two video details plus the video and music gallery lists.
    expect(invalidate).toHaveBeenCalledTimes(4);

    rerender(tree());
    expect(invalidate).toHaveBeenCalledTimes(4);
  });
});

describe('GenerationUpdatesListener music jobs', () => {
  it('patches a running frame into the music job and leaves video alone', async () => {
    queryClient.setQueryData(musicGenerationKeys.detail('song-1'), musicJob({ id: 'song-1', state: 'pending' }));
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    renderListener();
    await send(frame({ id: 'song-1', kind: 'music', state: 'running' }));
    expect(musicDetail('song-1')?.state).toBe('running');
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('refetches a finished song and the credit balance', async () => {
    queryClient.setQueryData(musicGenerationKeys.detail('song-1'), musicJob({ id: 'song-1', state: 'storing' }));
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    renderListener();
    await send(frame({ id: 'song-1', kind: 'music', state: 'succeeded' }));
    expect(musicDetail('song-1')?.state).toBe('succeeded');
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: musicGenerationKeys.detail('song-1'),
      exact: true,
      refetchType: 'all',
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['credits-balance'] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: videoGenerationKeys.list });
  });

  it('on reconnect refreshes the unfinished and awaiting-output songs only', async () => {
    queryClient.setQueryData(musicGenerationKeys.detail('live'), musicJob({ id: 'live', state: 'running' }));
    queryClient.setQueryData(
      musicGenerationKeys.detail('done'),
      musicJob({ id: 'done', state: 'succeeded', output: musicOutput() })
    );
    queryClient.setQueryData(
      musicGenerationKeys.detail('no-output'),
      musicJob({ id: 'no-output', state: 'succeeded', output: null })
    );
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { rerender } = renderListener();
    const tree = () => (
      <QueryClientProvider client={queryClient}>
        <GenerationUpdatesListener />
      </QueryClientProvider>
    );
    h.readyState = 3;
    rerender(tree());
    h.readyState = 1;
    rerender(tree());

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: musicGenerationKeys.detail('live'),
      exact: true,
      refetchType: 'all',
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: musicGenerationKeys.detail('no-output'),
      exact: true,
      refetchType: 'all',
    });
    expect(invalidate).not.toHaveBeenCalledWith({
      queryKey: musicGenerationKeys.detail('done'),
      exact: true,
      refetchType: 'all',
    });
  });
});

describe('GenerationUpdatesListener music gallery', () => {
  const musicList = (...jobs: MusicGeneration[]) => ({
    pages: [{ data: jobs, next_cursor: null }],
    pageParams: [undefined],
  });

  it('patches a song listed in the gallery', async () => {
    queryClient.setQueryData(musicGenerationKeys.list, musicList(musicJob({ id: 'song-1', state: 'pending' })));
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    renderListener();
    await send(frame({ id: 'song-1', kind: 'music', state: 'running' }));
    const list = queryClient.getQueryData<ReturnType<typeof musicList>>(musicGenerationKeys.list);
    expect(list?.pages[0].data[0].state).toBe('running');
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: musicGenerationKeys.list });
  });

  it('refreshes the gallery for a song started elsewhere (chat, API)', async () => {
    queryClient.setQueryData(musicGenerationKeys.list, musicList(musicJob()));
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    renderListener();
    await send(frame({ id: 'from-chat', kind: 'music', state: 'pending' }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: musicGenerationKeys.list });
  });

  it('refreshes the gallery on reconnect', async () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { rerender } = renderListener();
    const tree = () => (
      <QueryClientProvider client={queryClient}>
        <GenerationUpdatesListener />
      </QueryClientProvider>
    );
    h.readyState = 3;
    rerender(tree());
    h.readyState = 1;
    rerender(tree());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: musicGenerationKeys.list });
  });
});

describe('GenerationUpdatesListener inactive music details', () => {
  // No observer is mounted: only refetchType 'all' reaches a query like this (the card is in another notebook).
  const seedInactiveRunningSong = (id: string) => {
    const queryFn = vi.fn().mockResolvedValue(musicJob({ id, state: 'succeeded', output: musicOutput() }));
    queryClient.setQueryDefaults(musicGenerationKeys.detail(id), { queryFn });
    queryClient.setQueryData(musicGenerationKeys.detail(id), musicJob({ id, state: 'running' }));
    return queryFn;
  };

  it('refetches an inactive song detail on a terminal frame', async () => {
    const queryFn = seedInactiveRunningSong('song-1');
    renderListener();
    await send(frame({ id: 'song-1', kind: 'music', state: 'succeeded' }));
    expect(queryFn).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(musicDetail('song-1')?.output).not.toBeNull());
  });

  it('refetches an inactive running song detail on reconnect', async () => {
    const queryFn = seedInactiveRunningSong('song-1');
    const { rerender } = renderListener();
    const tree = () => (
      <QueryClientProvider client={queryClient}>
        <GenerationUpdatesListener />
      </QueryClientProvider>
    );
    h.readyState = 3;
    rerender(tree());
    h.readyState = 1;
    rerender(tree());
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));
  });
});

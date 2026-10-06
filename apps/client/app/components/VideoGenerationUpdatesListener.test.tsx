import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IGenerationJobUpdatedAction, VideoGeneration } from '@bike4mind/common';

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

import { listOf, videoJob } from '@client/app/hooks/data/__test__/videoGenerationFixtures';
import { videoGenerationKeys } from '@client/app/hooks/data/videoGenerationKeys';
import VideoGenerationUpdatesListener from './VideoGenerationUpdatesListener';

let queryClient: QueryClient;

const renderListener = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <VideoGenerationUpdatesListener />
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

const detail = (id: string) => queryClient.getQueryData<VideoGeneration>(videoGenerationKeys.detail(id));

beforeEach(() => {
  h.readyState = 1;
  h.handlers = [];
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

describe('VideoGenerationUpdatesListener', () => {
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
    expect(invalidate).toHaveBeenCalledWith({ queryKey: videoGenerationKeys.detail('job-1') });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['credits-balance'] });
  });

  it('refreshes the gallery for a job started elsewhere', async () => {
    queryClient.setQueryData(videoGenerationKeys.list, listOf([videoJob()]));
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    renderListener();
    await send(frame({ id: 'from-the-api', kind: 'video', state: 'pending' }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: videoGenerationKeys.list });
  });

  it('ignores other actions', async () => {
    queryClient.setQueryData(videoGenerationKeys.detail('job-1'), videoJob({ state: 'pending' }));
    renderListener();
    await act(async () => {
      await Promise.all(h.handlers.map(handler => handler({ action: 'invalidate_query', queryKey: ['x'] })));
    });
    expect(detail('job-1')?.state).toBe('pending');
  });

  it('on reconnect refreshes the list and only the unfinished jobs, once', async () => {
    queryClient.setQueryData(videoGenerationKeys.detail('live'), videoJob({ id: 'live', state: 'running' }));
    queryClient.setQueryData(videoGenerationKeys.detail('done'), videoJob({ id: 'done', state: 'succeeded' }));
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { rerender } = renderListener();
    // A fresh element each time: re-rendering the same element reference bails out before the mock is re-read.
    const tree = () => (
      <QueryClientProvider client={queryClient}>
        <VideoGenerationUpdatesListener />
      </QueryClientProvider>
    );

    // The first connect has nothing to catch up on.
    expect(invalidate).not.toHaveBeenCalled();

    h.readyState = 3;
    rerender(tree());
    h.readyState = 1;
    rerender(tree());

    expect(invalidate).toHaveBeenCalledWith({ queryKey: videoGenerationKeys.list });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: videoGenerationKeys.detail('live'), exact: true });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: videoGenerationKeys.detail('done'), exact: true });
    expect(invalidate).toHaveBeenCalledTimes(2);

    rerender(tree());
    expect(invalidate).toHaveBeenCalledTimes(2);
  });
});

import { AxiosError, AxiosHeaders } from 'axios';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@client/app/contexts/ApiContext', () => ({ api: {} }));
vi.mock('@client/app/contexts/WebsocketContext', () => ({ ReadyState: { OPEN: 1 }, useWebsocket: () => ({}) }));

import {
  describeStudioImageJobError,
  patchStudioImageJob,
  studioImageJobKeys,
  type StudioImageJob,
} from './studioImageJobs';

const refusal = (status: number, data: unknown) =>
  new AxiosError('refused', 'ERR', undefined, undefined, {
    status,
    data,
    statusText: '',
    headers: {},
    config: { headers: new AxiosHeaders() },
  });

describe('describeStudioImageJobError', () => {
  it('joins the why-not reasons of a 422', () => {
    const error = refusal(422, {
      error: 'unsupported_by_model',
      failures: [{ reason: 'This model does not take a size.' }, { reason: 'This model makes one image.' }],
    });
    expect(describeStudioImageJobError(error)).toBe('This model does not take a size. This model makes one image.');
  });

  it('explains a model whose Studio provider is not wired yet', () => {
    expect(describeStudioImageJobError(refusal(422, { error: 'model_unavailable', message: 'raw' }))).toBe(
      'This model is not available in Studio yet. Pick another model.'
    );
  });

  it('never shows the server text, and falls back for an unknown code or a network error', () => {
    expect(describeStudioImageJobError(refusal(400, { error: 'brand_new_code', message: 'raw' }))).toBe(
      'Could not start the images. Try again.'
    );
    expect(describeStudioImageJobError(new Error('offline'))).toBe('Could not start the images. Try again.');
  });

  it('uses the shared rate-limit text', () => {
    expect(describeStudioImageJobError(refusal(429, {}))).toBe('Too many requests. Wait a moment and try again.');
  });
});

describe('patchStudioImageJob', () => {
  const job = (state: StudioImageJob['state']): StudioImageJob => ({
    id: 'img-1',
    groupId: null,
    state,
    request: { model: 'gpt-image-1.5', mode: 'generate', prompt: 'p' } as StudioImageJob['request'],
    error: null,
    output: null,
    createdAt: '2026-11-01T00:00:00.000Z',
  });
  const seeded = (state: StudioImageJob['state']) => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(studioImageJobKeys.list, {
      pages: [{ data: [job(state)], next_cursor: null }],
      pageParams: [],
    });
    return queryClient;
  };
  const stateOf = (queryClient: QueryClient) =>
    queryClient.getQueryData<{ pages: { data: StudioImageJob[] }[] }>(studioImageJobKeys.list)?.pages[0]?.data[0]
      ?.state;

  it('moves a row forward and reports it was found', () => {
    const queryClient = seeded('pending');
    expect(patchStudioImageJob(queryClient, { id: 'img-1', state: 'running' })).toBe(true);
    expect(stateOf(queryClient)).toBe('running');
  });

  it('keeps a finished row final', () => {
    const queryClient = seeded('succeeded');
    patchStudioImageJob(queryClient, { id: 'img-1', state: 'running' });
    expect(stateOf(queryClient)).toBe('succeeded');
  });

  it('reports a job it does not hold, and leaves an unloaded list alone', () => {
    expect(patchStudioImageJob(seeded('pending'), { id: 'other', state: 'running' })).toBe(false);
    expect(patchStudioImageJob(new QueryClient(), { id: 'img-1', state: 'running' })).toBe(false);
  });
});

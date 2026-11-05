import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, AxiosHeaders, type AxiosResponse } from 'axios';
import { api } from '@client/app/contexts/ApiContext';
import { useShadowDetectionVerdict, type ShadowDetectionRow } from './shadowDetections';

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: vi.fn() } }));

const post = api.post as unknown as Mock;

const createWrapper = () => {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return Wrapper;
};

const DETECTION_ID = 'a'.repeat(24);

const row = (over: Partial<ShadowDetectionRow> = {}): ShadowDetectionRow => ({
  id: DETECTION_ID,
  detector: 'signupNetworkBurst',
  policyVersion: 1,
  wouldAction: 'contain',
  summary: '3 self-serve signups from one IP in 180 minutes',
  userIds: ['u1'],
  network: { ip: '203.0.113.7', asn: 64500, asnOrg: null, country: 'US', hosting: true },
  signals: [{ key: 'ipSignups', label: 'Self-serve signups from this IP', observed: 3, threshold: 1 }],
  windowMinutes: 180,
  group: null,
  payment: null,
  detectedAt: '2026-10-01T00:00:00.000Z',
  verdict: null,
  verdicts: [],
  revision: 0,
  ...over,
});

const REQUEST = { id: DETECTION_ID, expectedRevision: 0, verdict: 'confirmed_abuse', reason: 'Reviewed it' } as const;

const httpError = (status: number, data: unknown) => {
  const config = { headers: new AxiosHeaders() };
  const response: AxiosResponse = { status, statusText: '', data, headers: {}, config };
  return new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', config, null, response);
};

const submit = async () => {
  const { result } = renderHook(() => useShadowDetectionVerdict(), { wrapper: createWrapper() });
  let outcome: Promise<unknown> = Promise.resolve();
  act(() => {
    outcome = result.current.mutateAsync(REQUEST);
  });
  return outcome;
};

describe('useShadowDetectionVerdict', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves the updated detection on a 200', async () => {
    const graded = row({
      verdict: 'confirmed_abuse',
      revision: 1,
      verdicts: [
        { verdict: 'confirmed_abuse', reason: 'Reviewed it', reviewerId: 'r1', reviewedAt: '2026-10-02T00:00:00.000Z' },
      ],
    });
    post.mockResolvedValue({ data: graded });

    await expect(submit()).resolves.toEqual({ status: 'recorded', item: graded });
    expect(post).toHaveBeenCalledExactlyOnceWith('/api/admin/shadow-detections/verdict', REQUEST);
  });

  it('resolves a 409 as a conflict carrying the current detection and the server message', async () => {
    const current = row({
      verdict: 'legitimate_human',
      revision: 1,
      verdicts: [
        { verdict: 'legitimate_human', reason: 'Known team', reviewerId: 'r2', reviewedAt: '2026-10-02T00:00:00.000Z' },
      ],
    });
    post.mockRejectedValue(httpError(409, { error: 'Graded by someone else.', item: current }));

    await expect(submit()).resolves.toEqual({ status: 'conflict', item: current, message: 'Graded by someone else.' });
  });

  it('rejects a 409 whose body is not a detection', async () => {
    const error = httpError(409, { error: 'Graded by someone else.', item: { id: DETECTION_ID } });
    post.mockRejectedValue(error);

    await expect(submit()).rejects.toBe(error);
  });

  it('rejects any other failure, such as a 404', async () => {
    const error = httpError(404, { error: 'Detection not found' });
    post.mockRejectedValue(error);

    await expect(submit()).rejects.toBe(error);
  });
});

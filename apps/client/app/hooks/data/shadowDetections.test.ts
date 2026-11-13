import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, AxiosHeaders, type AxiosResponse } from 'axios';
import { api } from '@client/app/contexts/ApiContext';
import { useShadowDetectionBulkVerdict, useShadowDetectionVerdict, type ShadowDetectionRow } from './shadowDetections';

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
  it('recovers a stale synchronized observation including serialized scan timestamps', async () => {
    const current = row({
      detector: 'completionSynchrony',
      revision: 2,
      completionSynchrony: {
        source: 'api_key_request_starts',
        windowHours: 24,
        eventsScanned: 9,
        legacyRows: 0,
        scanTruncated: false,
        bursts: 3,
        synchronizedModelSwitches: 1,
        distinctRequestedModels: 2,
        maxStartSkewMilliseconds: 400,
        completedRequests: 6,
        dailyCapRejectedRequests: 3,
        otherRejectedRequests: 0,
        interruptedOrUnknownRequests: 0,
        scannedAt: '2026-01-01T12:00:00Z',
        firstObservedAt: '2026-01-01T11:50:00Z',
        lastObservedAt: '2026-01-01T11:59:00Z',
      },
    });
    post.mockRejectedValue(httpError(409, { error: 'Evidence refreshed', item: current }));
    expect(await submit()).toEqual({ status: 'conflict', item: current, message: 'Evidence refreshed' });
  });

  it('recovers a stale verdict with serialized sequence evidence', async () => {
    const current = row({
      detector: 'completionSequence',
      revision: 1,
      completionSequence: {
        source: 'completion_usage_ledger',
        windowHours: 24,
        eventsScanned: 6,
        scanTruncated: false,
        rounds: 2,
        minRequestsPerRound: 3,
        maxRequestsPerRound: 3,
        maxRoundSpanSeconds: 10,
        minGapSeconds: 60,
        maxGapSeconds: 60,
        firstObservedAt: '2026-01-01T12:00:00Z',
        lastObservedAt: '2026-01-01T12:02:00Z',
      },
    });
    post.mockRejectedValue(httpError(409, { error: 'Evidence changed', item: current }));
    expect(await submit()).toEqual({ status: 'conflict', item: current, message: 'Evidence changed' });
  });

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

describe('useShadowDetectionBulkVerdict', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('sends a large selection in batches of the server limit and merges the results', async () => {
    const items = Array.from({ length: 300 }, (_, index) => ({
      id: index.toString(16).padStart(24, '0'),
      expectedRevision: 0,
    }));
    post
      .mockResolvedValueOnce({ data: { graded: [row()], conflicts: [], missing: ['x'], failed: [] } })
      .mockResolvedValueOnce({
        data: { graded: [], conflicts: [row({ verdict: 'legitimate_human' })], missing: [], failed: [] },
      });
    const { result } = renderHook(() => useShadowDetectionBulkVerdict(), { wrapper: createWrapper() });

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.mutateAsync({ items, verdict: 'confirmed_abuse', reason: 'Same cohort' });
    });

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0]).toEqual([
      '/api/admin/shadow-detections/bulk-verdict',
      { items: items.slice(0, 200), verdict: 'confirmed_abuse', reason: 'Same cohort' },
    ]);
    expect(post.mock.calls[1][1].items).toEqual(items.slice(200));
    expect(outcome).toMatchObject({
      graded: [{ id: DETECTION_ID }],
      conflicts: [{ verdict: 'legitimate_human' }],
      missing: ['x'],
    });
  });

  it('preserves completed batches and reports the failed and unattempted ids for retry', async () => {
    const items = Array.from({ length: 450 }, (_, index) => ({
      id: index.toString(16).padStart(24, '0'),
      expectedRevision: 0,
    }));
    post
      .mockResolvedValueOnce({ data: { graded: [row()], conflicts: [], missing: [], failed: ['server-failed'] } })
      .mockRejectedValueOnce(new Error('Connection lost'));
    const { result } = renderHook(() => useShadowDetectionBulkVerdict(), { wrapper: createWrapper() });

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.mutateAsync({ items, verdict: 'confirmed_abuse', reason: 'Reviewed cohort' });
    });

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][1].items).toEqual(items.slice(200, 400));
    expect(outcome).toEqual({
      graded: [row()],
      conflicts: [],
      missing: [],
      failed: ['server-failed', ...items.slice(200).map(item => item.id)],
      failureMessage: 'Connection lost',
    });
  });
});

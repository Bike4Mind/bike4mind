import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import {
  MODERATION_INCIDENT_QUEUE_QUERY_KEY,
  MODERATION_INCIDENT_SUMMARY_QUERY_KEY,
  useModerationIncidentEscalation,
  useModerationIncidentQueue,
  useModerationIncidentSummary,
  useModerationIncidentVerdict,
} from './moderationIncidents';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get, post: mocks.post } }));

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

const incidents = (count: number, day: number) =>
  Array.from({ length: count }, (_, i) => ({
    _id: `id-${day}-${i}`,
    createdAt: new Date(Date.UTC(2026, 9, day, 0, i)).toISOString(),
  }));

const loadQueue = async (
  data: { incidents: unknown[]; staleConfirmedCsam: unknown[]; hasMore?: boolean },
  ...args: Parameters<typeof useModerationIncidentQueue>
) => {
  mocks.get.mockResolvedValue({ data });
  const view = renderHook(() => useModerationIncidentQueue(...args), { wrapper });
  await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
  return view.result.current.data;
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe('useModerationIncidentQueue', () => {
  it('merges both lists oldest first and marks the stuck claims', async () => {
    const data = await loadQueue({ incidents: incidents(1, 3), staleConfirmedCsam: incidents(1, 2) });

    expect(mocks.get).toHaveBeenCalledWith('/api/admin/moderation-incidents', {
      params: { limit: 100, status: 'open' },
    });
    expect(data?.rows.map(row => [row.id, row.stuck])).toEqual([
      ['id-2-0', true],
      ['id-3-0', false],
    ]);
    expect(data?.truncated).toBe(false);
  });

  it('is not truncated one short of the cap', async () => {
    const data = await loadQueue({ incidents: incidents(99, 3), staleConfirmedCsam: incidents(99, 2) });
    expect(data?.truncated).toBe(false);
  });

  it.each([
    ['unreviewed', { incidents: incidents(100, 3), staleConfirmedCsam: [] }],
    ['stuck', { incidents: [], staleConfirmedCsam: incidents(100, 2) }],
  ])('is truncated when the %s list comes back at the cap', async (_label, lists) => {
    const data = await loadQueue(lists);
    expect(data?.truncated).toBe(true);
  });

  it('marks the escalated rows', async () => {
    const [plain, escalated] = incidents(2, 3);
    const data = await loadQueue({
      incidents: [plain, { ...escalated, escalatedAt: '2026-10-04T00:00:00.000Z' }],
      staleConfirmedCsam: [],
    });
    expect(data?.rows.map(row => [row.id, row.escalated])).toEqual([
      ['id-3-0', false],
      ['id-3-1', true],
    ]);
  });

  it('ignores a closed cursor on the open queue', async () => {
    await loadQueue({ incidents: [], staleConfirmedCsam: [] }, 'open', {
      before: '2026-10-03T00:00:00.000Z',
      beforeId: 'abc',
    });
    expect(mocks.get).toHaveBeenCalledWith('/api/admin/moderation-incidents', {
      params: { limit: 100, status: 'open' },
    });
  });
});

describe('useModerationIncidentQueue (closed)', () => {
  it('requests closed incidents and lists them newest first', async () => {
    const data = await loadQueue(
      { incidents: [...incidents(1, 2), ...incidents(1, 4), ...incidents(1, 3)], staleConfirmedCsam: [] },
      'closed'
    );

    expect(mocks.get).toHaveBeenCalledWith('/api/admin/moderation-incidents', {
      params: { limit: 100, status: 'closed' },
    });
    expect(data?.rows.map(row => row.id)).toEqual(['id-4-0', 'id-3-0', 'id-2-0']);
    expect(data?.truncated).toBe(false);
  });

  it('pages back with the before and beforeId cursor and takes truncated from hasMore', async () => {
    const data = await loadQueue({ incidents: incidents(100, 2), staleConfirmedCsam: [], hasMore: true }, 'closed', {
      before: '2026-10-03T00:00:00.000Z',
      beforeId: 'abc',
    });

    expect(mocks.get).toHaveBeenCalledWith('/api/admin/moderation-incidents', {
      params: { limit: 100, status: 'closed', before: '2026-10-03T00:00:00.000Z', beforeId: 'abc' },
    });
    expect(data?.truncated).toBe(true);
  });

  it('is not truncated for an exactly full closed page when hasMore is false', async () => {
    const data = await loadQueue({ incidents: incidents(100, 2), staleConfirmedCsam: [], hasMore: false }, 'closed');
    expect(data?.truncated).toBe(false);
  });
});

describe('useModerationIncidentSummary', () => {
  it('reads the counts and reviewer list flags from the summary route', async () => {
    const summary = {
      needsReview: 3,
      escalated: 1,
      stuck: 0,
      closed: { noAction: 4, falsePositive: 2, reported: 1 },
      oldestPendingCreatedAt: '2026-10-30T10:00:00.000Z',
      reviewersConfigured: true,
      escalationReviewersConfigured: false,
    };
    mocks.get.mockResolvedValue({ data: summary });
    const { result } = renderHook(() => useModerationIncidentSummary(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith('/api/admin/moderation-incidents/summary');
    expect(result.current.data).toEqual(summary);
  });
});

describe('moderation incident writes', () => {
  const trackedWrapper = () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    return { invalidatedKeys: () => invalidate.mock.calls.map(([filters]) => filters?.queryKey), wrapper: Wrapper };
  };

  const REVIEW_PAGE_KEYS = [MODERATION_INCIDENT_QUEUE_QUERY_KEY, MODERATION_INCIDENT_SUMMARY_QUERY_KEY];

  it('refreshes the queue and its summary after a verdict, even a refused one', async () => {
    mocks.post.mockRejectedValue(new Error('refused'));
    const { invalidatedKeys, wrapper: tracked } = trackedWrapper();
    const { result } = renderHook(() => useModerationIncidentVerdict(), { wrapper: tracked });

    await act(async () => {
      await result.current
        .mutateAsync({ id: 'inc-1', verdict: { kind: 'no_action' }, reason: 'Checked it' })
        .catch(() => undefined);
    });

    expect(invalidatedKeys()).toEqual(expect.arrayContaining(REVIEW_PAGE_KEYS));
  });

  it('refreshes the queue and its summary after an escalation, even a refused one', async () => {
    mocks.post.mockRejectedValue(new Error('refused'));
    const { invalidatedKeys, wrapper: tracked } = trackedWrapper();
    const { result } = renderHook(() => useModerationIncidentEscalation(), { wrapper: tracked });

    await act(async () => {
      await result.current.mutateAsync({ id: 'inc-1', reason: 'Needs a second opinion' }).catch(() => undefined);
    });

    expect(invalidatedKeys()).toEqual(expect.arrayContaining(REVIEW_PAGE_KEYS));
  });

  // Both go through the shared api client, whose step-up interceptor prompts and replays them.
  it('sends the reviewer reason with a verdict', async () => {
    mocks.post.mockResolvedValue({ data: { ok: true } });
    const { result } = renderHook(() => useModerationIncidentVerdict(), { wrapper });

    await act(() =>
      result.current.mutateAsync({ id: 'inc/1', verdict: { kind: 'confirmed', reportId: 'R-1' }, reason: 'Filed it' })
    );

    expect(mocks.post).toHaveBeenCalledWith('/api/admin/moderation-incidents/inc%2F1/verdict', {
      verdict: 'record_manual_report',
      ncmecReportId: 'R-1',
      reason: 'Filed it',
    });
  });

  it('posts an escalation with its reason and returns the outcome', async () => {
    const response = {
      ok: true,
      incident: {
        id: 'inc-1',
        reviewStatus: 'pending_review',
        escalatedAt: '2026-10-30T12:00:00.000Z',
        escalationTrigger: 'manual',
        escalationAlertedAt: null,
      },
      alert: 'no_recipients',
    };
    mocks.post.mockResolvedValue({ data: response });
    const { result } = renderHook(() => useModerationIncidentEscalation(), { wrapper });

    let returned: unknown;
    await act(async () => {
      returned = await result.current.mutateAsync({ id: 'inc-1', reason: 'Needs a second opinion' });
    });

    expect(mocks.post).toHaveBeenCalledWith('/api/admin/moderation-incidents/inc-1/escalate', {
      reason: 'Needs a second opinion',
    });
    expect(returned).toEqual(response);
  });
});

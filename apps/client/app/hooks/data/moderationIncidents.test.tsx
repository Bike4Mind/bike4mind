import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useModerationIncidentQueue } from './moderationIncidents';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get } }));

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
  data: { incidents: unknown[]; staleConfirmedCsam: unknown[] },
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

  it('ignores a closed cursor on the open queue', async () => {
    await loadQueue({ incidents: [], staleConfirmedCsam: [] }, 'open', '2026-10-03T00:00:00.000Z');
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

  it('pages back with the before cursor and reports a full page as truncated', async () => {
    const data = await loadQueue(
      { incidents: incidents(100, 2), staleConfirmedCsam: [] },
      'closed',
      '2026-10-03T00:00:00.000Z'
    );

    expect(mocks.get).toHaveBeenCalledWith('/api/admin/moderation-incidents', {
      params: { limit: 100, status: 'closed', before: '2026-10-03T00:00:00.000Z' },
    });
    expect(data?.truncated).toBe(true);
  });
});

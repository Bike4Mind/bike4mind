import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WebhookAuditStatus } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useWebhookAuditLogs, useWebhookAuditStats, type WebhookAuditFiltersParams } from './webhookAuditLogs';

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: vi.fn() },
}));

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(
    QueryClientProvider,
    { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
    children
  );

const RANGE = { startDate: '2026-10-14T00:00:00.000Z', endDate: '2026-10-21T00:00:00.000Z' };
const UNFILTERED: WebhookAuditFiltersParams = { ...RANGE, limit: 50 };
const FAILED_ONLY: WebhookAuditFiltersParams = { ...UNFILTERED, status: WebhookAuditStatus.Failed };

type Body = Record<string, unknown>;

/** Answers the unfiltered request at once and holds the `status=failed` one until released. */
const holdFailedFilter = (unfiltered: Body) => {
  let release: ((value: { data: Body }) => void) | undefined;
  vi.mocked(api.get).mockImplementation((_url: string, config?: { params?: Record<string, string> }) =>
    config?.params?.status === 'failed'
      ? new Promise(resolve => {
          release = resolve;
        })
      : Promise.resolve({ data: unfiltered })
  );
  return { released: () => release !== undefined, release: (data: Body) => release?.({ data }) };
};

beforeEach(() => {
  vi.mocked(api.get).mockReset();
});

describe('webhook audit hooks on a filter change', () => {
  it('keeps the previous deliveries while the filtered list loads', async () => {
    const request = holdFailedFilter({ logs: [{ deliveryId: 'old' }], nextCursor: 'c1' });
    const { result, rerender } = renderHook(({ filters }) => useWebhookAuditLogs(filters), {
      wrapper,
      initialProps: { filters: UNFILTERED },
    });
    await waitFor(() => expect(result.current.data?.pages[0].logs[0].deliveryId).toBe('old'));

    rerender({ filters: FAILED_ONLY });
    await waitFor(() => expect(request.released()).toBe(true));
    expect(result.current.data?.pages[0].logs[0].deliveryId).toBe('old');
    expect(result.current.isPlaceholderData).toBe(true);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isFetching).toBe(true);

    await act(async () => request.release({ logs: [{ deliveryId: 'new' }] }));
    await waitFor(() => expect(result.current.data?.pages[0].logs[0].deliveryId).toBe('new'));
    expect(result.current.isPlaceholderData).toBe(false);
  });

  it('keeps the previous totals while the filtered stats load', async () => {
    const request = holdFailedFilter({ totalDeliveries: 10 });
    const { result, rerender } = renderHook(({ filters }) => useWebhookAuditStats(RANGE, filters), {
      wrapper,
      initialProps: { filters: {} as Pick<WebhookAuditFiltersParams, 'status'> },
    });
    await waitFor(() => expect(result.current.data?.totalDeliveries).toBe(10));

    rerender({ filters: { status: WebhookAuditStatus.Failed } });
    await waitFor(() => expect(request.released()).toBe(true));
    expect(result.current.data?.totalDeliveries).toBe(10);
    expect(result.current.isPlaceholderData).toBe(true);
    expect(result.current.isLoading).toBe(false);

    await act(async () => request.release({ totalDeliveries: 3 }));
    await waitFor(() => expect(result.current.data?.totalDeliveries).toBe(3));
  });
});

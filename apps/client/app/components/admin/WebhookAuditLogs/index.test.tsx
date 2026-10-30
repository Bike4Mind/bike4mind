import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AxiosError, type AxiosResponse } from 'axios';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({
  useWebhookAuditLog: vi.fn(),
}));

vi.mock('@tanstack/react-router', async () => (await import('../__tests__/fakeAdminRouter')).fakeRouterModule);
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('@client/app/hooks/data/webhookAuditLogs', () => ({
  useWebhookAuditLogs: () => ({
    data: { pages: [{ logs: [] }] },
    isLoading: false,
    isFetching: false,
    isFetchingNextPage: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
    error: null,
    isError: false,
  }),
  useWebhookAuditStats: () => ({ data: undefined, isLoading: false, error: null, isError: false }),
  useWebhookAuditLog: mocks.useWebhookAuditLog,
  getDateRangePreset: () => ({ startDate: '2026-10-14T00:00:00.000Z', endDate: '2026-10-21T00:00:00.000Z' }),
}));

import { fakeAdminRouter } from '../__tests__/fakeAdminRouter';
import WebhookAuditLogsTab from './index';

const DELIVERY_ID = '8f1c2e40-1d2b-11ef-9a3c-5b1e2d3c4f5a';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderTab = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <WebhookAuditLogsTab />
    </CssVarsProvider>
  );

// Joy keeps a closed drawer mounted, hidden from assistive tech.
const isDrawerOpen = () => {
  const drawer = screen.queryByTestId('webhook-details-drawer');
  return drawer !== null && drawer.getAttribute('aria-hidden') !== 'true';
};

const notFound = () =>
  new AxiosError('Not Found', 'ERR_BAD_REQUEST', undefined, undefined, { status: 404 } as AxiosResponse);

describe('WebhookAuditLogsTab delivery drawer', () => {
  beforeEach(() => {
    mocks.useWebhookAuditLog.mockReset();
    mocks.useWebhookAuditLog.mockReturnValue({ data: undefined, isLoading: true, error: null });
  });

  it('opens the delivery a link names and closes it by removing the param', async () => {
    act(() => fakeAdminRouter.reset({ tab: 'webhook-audit-logs', webhookDeliveryId: DELIVERY_ID }));
    renderTab();

    await waitFor(() => expect(isDrawerOpen()).toBe(true));
    expect(mocks.useWebhookAuditLog).toHaveBeenLastCalledWith(DELIVERY_ID);

    await userEvent.click(screen.getByTestId('webhook-details-close-btn'));

    expect(fakeAdminRouter.search).toEqual({ tab: 'webhook-audit-logs' });
    await waitFor(() => expect(isDrawerOpen()).toBe(false));
  });

  it('closes cleanly when the linked delivery does not exist', async () => {
    mocks.useWebhookAuditLog.mockImplementation((deliveryId: string | null) =>
      deliveryId
        ? { data: undefined, isLoading: false, error: notFound() }
        : { data: undefined, isLoading: false, error: null }
    );
    act(() => fakeAdminRouter.reset({ tab: 'webhook-audit-logs', webhookDeliveryId: DELIVERY_ID }));
    renderTab();

    await waitFor(() => expect(fakeAdminRouter.search).toEqual({ tab: 'webhook-audit-logs' }));
    expect(isDrawerOpen()).toBe(false);
  });

  it('keeps the drawer open on an error that is not a missing delivery', async () => {
    mocks.useWebhookAuditLog.mockReturnValue({ data: undefined, isLoading: false, error: new Error('network') });
    act(() => fakeAdminRouter.reset({ tab: 'webhook-audit-logs', webhookDeliveryId: DELIVERY_ID }));
    renderTab();

    await waitFor(() => expect(isDrawerOpen()).toBe(true));
    expect(fakeAdminRouter.search).toMatchObject({ webhookDeliveryId: DELIVERY_ID });
  });

  it('never opens a drawer for a malformed id', () => {
    act(() => fakeAdminRouter.reset({ tab: 'webhook-audit-logs', webhookDeliveryId: '../users' }));
    renderTab();

    expect(isDrawerOpen()).toBe(false);
    expect(mocks.useWebhookAuditLog).toHaveBeenLastCalledWith(null);
  });
});

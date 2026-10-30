import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { WebhookAuditStatus } from '@bike4mind/common';

vi.mock('@tanstack/react-router', async () => (await import('../__tests__/fakeAdminRouter')).fakeRouterModule);

import { fakeAdminRouter } from '../__tests__/fakeAdminRouter';
import { REPO_FILTER_URL_DEBOUNCE_MS, useWebhookAuditLogsSearch } from './useWebhookAuditLogsSearch';

const DELIVERY_ID = '8f1c2e40-1d2b-11ef-9a3c-5b1e2d3c4f5a';

describe('useWebhookAuditLogsSearch', () => {
  beforeEach(() => {
    act(() => fakeAdminRouter.reset({ tab: 'webhook-audit-logs' }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const setup = () => renderHook(() => useWebhookAuditLogsSearch());

  it('reads the filters from a deep link without writing on mount', () => {
    act(() =>
      fakeAdminRouter.reset({
        tab: 'webhook-audit-logs',
        webhookRange: '90d',
        webhookRepo: 'acme/widgets',
        webhookStatus: 'failed',
        webhookDeliveryId: DELIVERY_ID,
      })
    );
    const { result } = setup();

    expect(result.current.view).toMatchObject({
      datePreset: '90d',
      repository: 'acme/widgets',
      status: WebhookAuditStatus.Failed,
    });
    expect(result.current.repoInput).toBe('acme/widgets');
    expect(result.current.deliveryId).toBe(DELIVERY_ID);
    expect(fakeAdminRouter.navigate).not.toHaveBeenCalled();
  });

  it('writes a filter with replace and removes it again at its default', () => {
    const { result } = setup();

    act(() => result.current.updateView({ event: 'push', datePreset: '30d' }));
    expect(fakeAdminRouter.search).toEqual({ tab: 'webhook-audit-logs', webhookEvent: 'push', webhookRange: '30d' });
    expect(fakeAdminRouter.navigate).toHaveBeenLastCalledWith(expect.objectContaining({ replace: true }));

    act(() => result.current.updateView({ event: null, datePreset: '7d' }));
    expect(fakeAdminRouter.search).toEqual({ tab: 'webhook-audit-logs' });
  });

  it('writes the repository once typing pauses', () => {
    vi.useFakeTimers();
    const { result } = setup();

    act(() => result.current.setRepoInput('acme/wid'));
    act(() => result.current.setRepoInput('acme/widgets'));
    expect(result.current.repoInput).toBe('acme/widgets');
    expect(fakeAdminRouter.navigate).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(REPO_FILTER_URL_DEBOUNCE_MS));
    expect(fakeAdminRouter.navigate).toHaveBeenCalledTimes(1);
    expect(fakeAdminRouter.search).toMatchObject({ webhookRepo: 'acme/widgets' });
  });

  it('clears the box when the repository is removed from outside it', () => {
    act(() => fakeAdminRouter.reset({ tab: 'webhook-audit-logs', webhookRepo: 'acme/widgets' }));
    const { result } = setup();

    act(() => result.current.updateView({ repository: '' }));

    expect(result.current.repoInput).toBe('');
    expect(fakeAdminRouter.search).not.toHaveProperty('webhookRepo');
  });

  it('drops typing still waiting to be written when "Clear all" clears the repository', () => {
    vi.useFakeTimers();
    const { result } = setup();

    act(() => result.current.setRepoInput('acme/widgets'));
    act(() => result.current.updateView({ repository: '', event: null }));
    act(() => vi.advanceTimersByTime(REPO_FILTER_URL_DEBOUNCE_MS));

    expect(result.current.repoInput).toBe('');
    expect(fakeAdminRouter.search).toEqual({ tab: 'webhook-audit-logs' });
  });

  it('opens and closes a delivery through the URL', () => {
    const { result } = setup();

    act(() => result.current.openDelivery(DELIVERY_ID));
    expect(fakeAdminRouter.search).toMatchObject({ webhookDeliveryId: DELIVERY_ID });
    expect(result.current.deliveryId).toBe(DELIVERY_ID);

    act(() => result.current.closeDelivery());
    expect(fakeAdminRouter.search).toEqual({ tab: 'webhook-audit-logs' });
    expect(result.current.deliveryId).toBeUndefined();
  });

  it('keeps the open delivery when a filter changes', () => {
    act(() => fakeAdminRouter.reset({ tab: 'webhook-audit-logs', webhookDeliveryId: DELIVERY_ID }));
    const { result } = setup();

    act(() => result.current.updateView({ sourceType: 'org' }));

    expect(fakeAdminRouter.search).toMatchObject({ webhookDeliveryId: DELIVERY_ID, webhookSource: 'org' });
  });
});

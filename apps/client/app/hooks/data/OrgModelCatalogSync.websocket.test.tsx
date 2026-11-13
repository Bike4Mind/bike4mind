// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { IUserDocument } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { useSelectedAccount } from '@client/app/components/Credits/selectedAccountStore';
import { useSubscribeCollection } from '@client/app/utils/react-query';
import { catalogQueryKey } from './useModelInfo';
import { OrgModelCatalogSync } from './OrgModelCatalogSync';

const socket = vi.hoisted(() => ({
  readyState: 1,
  frames: [] as Record<string, unknown>[],
  listeners: new Set<(message: unknown) => unknown>(),
  sendJsonMessage: vi.fn(),
  subscribeToAction: vi.fn(),
}));
vi.mock('@/app/contexts/WebsocketContext', () => ({ useWebsocket: () => socket }));
vi.mock('@client/app/contexts/UserContext', async () => {
  const { create } = await import('zustand');
  return { useUser: create<{ currentUser: { id: string } | null }>(() => ({ currentUser: null })) };
});
const orgId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const otherId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const clients: QueryClient[] = [];
const client = () => {
  const value = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  value.setQueryData(catalogQueryKey(orgId), { models: [], lockedModels: [], supersededModels: [] });
  clients.push(value);
  return value;
};
const select = (id: string) =>
  useSelectedAccount.setState({ selectedAccount: { id, personal: false, name: id, credits: 10 } });
const tick = async (milliseconds = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
};
const latestFrame = () => socket.frames.filter(frame => frame.action === 'subscribe_query').at(-1)!;
async function emit(subscriptionId: unknown) {
  await act(async () => {
    for (const listener of socket.listeners)
      await listener({
        action: 'data_update',
        operationType: 'insert',
        collectionName: 'organizations',
        subscriptionId,
        data: { _id: orgId, id: orgId, modelPolicy: { allowedTools: [] } },
      });
    await vi.advanceTimersByTimeAsync(0);
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  socket.readyState = 1;
  socket.frames.length = 0;
  socket.listeners.clear();
  socket.sendJsonMessage.mockReset().mockImplementation((frame: Record<string, unknown>) => {
    socket.frames.push(frame);
  });
  socket.subscribeToAction
    .mockReset()
    .mockImplementation((_action: string, listener: (message: unknown) => unknown) => {
      socket.listeners.add(listener);
      return () => {
        socket.listeners.delete(listener);
      };
    });
  useAccessToken.setState({ accessToken: 'test-token', mfaPending: false });
  useUser.setState({ currentUser: { id: 'viewer' } as IUserDocument });
  select(orgId);
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach(value => value.clear());
  useAccessToken.getState().resetTokens();
  useUser.setState({ currentUser: null });
  useSelectedAccount.setState({ selectedAccount: null });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('catalog listener through the real subscription hook', () => {
  it('uses a fresh wire identity for A/B/A and ignores a frame for the original A subscription', async () => {
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.1).mockReturnValueOnce(0.2).mockReturnValueOnce(0.3);
    const queries = client();
    const invalidate = vi.spyOn(queries, 'invalidateQueries');
    render(
      <QueryClientProvider client={queries}>
        <OrgModelCatalogSync />
      </QueryClientProvider>
    );
    await tick(100);
    const oldId = latestFrame().subscriptionId;
    await act(async () => {
      select(otherId);
    });
    await tick(100);
    await act(async () => {
      select(orgId);
    });
    await tick(100);
    expect(latestFrame().subscriptionId).not.toBe(oldId);
    await emit(oldId);
    expect(invalidate).not.toHaveBeenCalled();
    await emit(latestFrame().subscriptionId);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('keeps ordinary subscriptions off the signal-only ordering protocol', async () => {
    const queries = client();
    function OrdinarySubscription() {
      useSubscribeCollection('organizations', { _id: orgId });
      return null;
    }
    render(
      <QueryClientProvider client={queries}>
        <OrdinarySubscription />
      </QueryClientProvider>
    );
    await tick(100);
    expect(latestFrame().initialDataAfterSubscribe).toBeUndefined();
  });

  it('sends the opt-in and catches up on ordinary reconnect and same-socket reauth snapshots', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const queries = client();
    const invalidate = vi.spyOn(queries, 'invalidateQueries');
    const tree = () => (
      <QueryClientProvider client={queries}>
        <OrgModelCatalogSync />
      </QueryClientProvider>
    );
    const view = render(tree());
    await tick(100);
    expect(latestFrame()).toMatchObject({
      collectionName: 'organizations',
      query: { _id: orgId },
      fields: {},
      fetchInitialData: true,
      initialDataAfterSubscribe: true,
    });
    await emit(latestFrame().subscriptionId);
    expect(invalidate).toHaveBeenCalledTimes(1);
    await emit(latestFrame().subscriptionId);
    expect(invalidate).toHaveBeenCalledTimes(2);
    await act(async () => {
      socket.readyState = 3;
      view.rerender(tree());
    });
    await act(async () => {
      socket.readyState = 1;
      view.rerender(tree());
    });
    await tick(1300);
    expect(socket.frames.filter(frame => frame.action === 'subscribe_query')).toHaveLength(2);
    expect(latestFrame().initialDataAfterSubscribe).toBe(true);
    await emit(latestFrame().subscriptionId);
    expect(invalidate).toHaveBeenCalledTimes(3);
  });
});

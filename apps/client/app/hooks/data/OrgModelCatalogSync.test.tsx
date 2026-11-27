// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ModelBackend, type IUserDocument, type ModelInfo } from '@bike4mind/common';
import type { ModelCatalog } from '@client/app/utils/llm';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { useSelectedAccount } from '@client/app/components/Credits/selectedAccountStore';
import { useUser } from '@client/app/contexts/UserContext';
import { catalogQueryKey } from './useModelInfo';
import { useResetOrgModelPolicy, useSaveOrgModelPolicy } from './useOrgModelPolicy';
import { OrgModelCatalogSync } from './OrgModelCatalogSync';

type Subscription = {
  query: Record<string, unknown> | null;
  callback: (operation: string, data: unknown) => void;
  active: boolean;
  options?: { fetchInitialData?: boolean; initialDataAfterSubscribe?: boolean };
};
const transport = vi.hoisted(() => ({ subscriptions: [] as Subscription[] }));
vi.mock('@client/app/utils/react-query', async () => {
  const { useEffect } = await import('react');
  return {
    useSubscribeCollection: (
      _collection: string,
      query: Record<string, unknown> | null,
      callback: Subscription['callback'],
      options?: Subscription['options']
    ) => {
      const organizationId = query?._id;
      const fetchInitialData = options?.fetchInitialData;
      const initialDataAfterSubscribe = options?.initialDataAfterSubscribe;
      useEffect(() => {
        const subscription = {
          query: organizationId === undefined ? null : { _id: organizationId },
          callback,
          options: { fetchInitialData, initialDataAfterSubscribe },
          active: true,
        };
        transport.subscriptions.push(subscription);
        return () => {
          subscription.active = false;
        };
      }, [organizationId, callback, fetchInitialData, initialDataAfterSubscribe]);
    },
  };
});
vi.mock('@client/app/contexts/UserContext', async () => {
  const { create } = await import('zustand');
  return { useUser: create<{ currentUser: { id: string } | null }>(() => ({ currentUser: null })) };
});
const network = vi.hoisted(() => ({ put: vi.fn(), delete: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: network }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const clients: QueryClient[] = [];
const createClient = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  clients.push(client);
  return client;
};
const catalog = (id: string): ModelCatalog => ({
  models: [{ id, name: id, type: 'text', backend: ModelBackend.OpenAI } as ModelInfo],
  lockedModels: [],
  supersededModels: [],
  modelListRevision: null,
  catalogUnavailable: false,
});
const select = (id: string, personal = false, credits = 10) =>
  useSelectedAccount.setState({
    selectedAccount: { id, personal, name: id, credits },
  });
const seed = (client: QueryClient) => {
  for (const id of [null, 'org-a', 'org-b']) client.setQueryData(catalogQueryKey(id), catalog(id ?? 'personal'));
};
function Observer({ orgId, fetch, name }: { orgId: string; fetch: () => Promise<ModelCatalog>; name: string }) {
  const { data } = useQuery({ queryKey: catalogQueryKey(orgId), queryFn: fetch });
  return <div data-testid={name}>{data?.models[0]?.id}</div>;
}
function mount(client: QueryClient, fetch?: () => Promise<ModelCatalog>, name = 'catalog') {
  return render(
    <QueryClientProvider client={client}>
      <OrgModelCatalogSync />
      {fetch && <Observer orgId="org-a" fetch={fetch} name={name} />}
    </QueryClientProvider>
  );
}
async function emit(
  subscription: Subscription,
  operation: string,
  policy?: unknown,
  extra: Record<string, unknown> = {}
) {
  await act(async () => {
    subscription.callback(operation, { id: 'org-a', _id: 'org-a', modelPolicy: policy, ...extra });
  });
}

beforeEach(() => {
  transport.subscriptions.length = 0;
  useAccessToken.setState({ accessToken: 'test-session', mfaPending: false });
  useUser.setState({ currentUser: { id: 'viewer' } as IUserDocument });
  select('org-a');
  network.put.mockResolvedValue({
    data: { policy: { allowedProviders: null, allowedModels: null, allowedTools: null }, invalidStored: false },
  });
  network.delete.mockResolvedValue({
    data: { policy: { allowedProviders: null, allowedModels: null, allowedTools: null }, invalidStored: false },
  });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  useAccessToken.getState().resetTokens();
  useUser.setState({ currentUser: null });
  useSelectedAccount.setState({ selectedAccount: null });
  vi.restoreAllMocks();
});

describe('organization catalog synchronization', () => {
  it('refreshes a remote member catalog after tighten/reset without touching personal or another org', async () => {
    const owner = createClient();
    const member = createClient();
    seed(owner);
    seed(member);
    let response = catalog('restricted');
    const ownerFetch = vi.fn(async () => response);
    const memberFetch = vi.fn(async () => response);
    const personal = member.getQueryData(catalogQueryKey(null));
    const other = member.getQueryData(catalogQueryKey('org-b'));
    mount(owner, ownerFetch, 'owner');
    mount(member, memberFetch, 'member');
    expect(transport.subscriptions).toHaveLength(2);
    await act(async () => {
      await owner.invalidateQueries({ queryKey: catalogQueryKey('org-a'), exact: true });
    });
    await emit(transport.subscriptions[1], 'update', { allowedModels: ['restricted'] });
    await waitFor(() => expect(screen.getByTestId('member').textContent).toBe('restricted'));
    expect(screen.getByTestId('owner').textContent).toBe('restricted');
    response = catalog('restored');
    await emit(transport.subscriptions[1], 'update', null);
    await waitFor(() => expect(screen.getByTestId('member').textContent).toBe('restored'));
    expect(member.getQueryData(catalogQueryKey(null))).toBe(personal);
    expect(member.getQueryData(catalogQueryKey('org-b'))).toBe(other);
    expect(ownerFetch).toHaveBeenCalledTimes(1);
    expect(memberFetch).toHaveBeenCalledTimes(2);
  });

  it('catches up on every initial/reconnect/reauth insert, while unrelated updates do not refetch or resubscribe', async () => {
    const client = createClient();
    seed(client);
    const fetch = vi.fn(async () => catalog('fresh'));
    mount(client, fetch);
    const subscription = transport.subscriptions[0];
    expect(subscription.options).toEqual({ fetchInitialData: true, initialDataAfterSubscribe: true });
    const policy = { allowedTools: [], allowedProviders: ['openai'] };
    for (let replay = 1; replay <= 3; replay++) {
      await emit(subscription, 'insert', policy);
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(replay));
    }
    for (let credit = 0; credit < 100; credit++) {
      await emit(
        subscription,
        'update',
        { allowedProviders: ['openai'], allowedTools: [] },
        { currentCredits: credit }
      );
    }
    await act(async () => {
      select('org-a', false, 500);
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(transport.subscriptions).toHaveLength(1);
    expect(transport.subscriptions[0].callback).toBe(subscription.callback);
  });

  it('rejects old A callbacks after A/B/A, foreign payloads, and callbacks during logout before effect cleanup', async () => {
    const client = createClient();
    seed(client);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    mount(client);
    const oldA = transport.subscriptions[0];
    await act(async () => {
      select('org-b');
    });
    await act(async () => {
      select('org-a');
    });
    expect(transport.subscriptions).toHaveLength(3);
    await emit(oldA, 'insert', { allowedTools: [] });
    expect(invalidate).not.toHaveBeenCalled();
    const current = transport.subscriptions[2];
    await emit(current, 'update', {}, { id: 'org-b' });
    expect(invalidate).not.toHaveBeenCalled();
    await act(async () => {
      useAccessToken.setState({ accessToken: null });
      current.callback('insert', { _id: 'org-a', modelPolicy: {} });
    });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it.each([true, false])('cancels a deferred stale catalog so its late result cannot win (empty=%s)', async empty => {
    const client = createClient();
    if (!empty) seed(client);
    let resolveOld: ((value: ModelCatalog) => void) | undefined;
    const old = new Promise<ModelCatalog>(resolve => {
      resolveOld = resolve;
    });
    const fresh = catalog('new-policy');
    const fetch = vi.fn<() => Promise<ModelCatalog>>().mockReturnValueOnce(old).mockResolvedValue(fresh);
    if (!empty) await client.invalidateQueries({ queryKey: catalogQueryKey('org-a'), exact: true });
    mount(client, fetch);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await emit(transport.subscriptions[0], 'insert', { allowedModels: ['new-policy'] });
    await waitFor(() => expect(screen.getByTestId('catalog').textContent).toBe('new-policy'));
    await act(async () => {
      resolveOld?.(catalog('stale-policy'));
      await old;
    });
    expect(client.getQueryData(catalogQueryKey('org-a'))).toEqual(fresh);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('coalesces a burst to the latest policy and stops queued work after unmount', async () => {
    const client = createClient();
    seed(client);
    const fetch = vi.fn(async () => catalog('latest'));
    const view = mount(client, fetch);
    const subscription = transport.subscriptions[0];
    await act(async () => {
      for (let revision = 0; revision < 10; revision++)
        subscription.callback('update', {
          _id: 'org-a',
          modelPolicy: { allowedModels: [`revision-${revision}`] },
        });
    });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await act(async () => {
      subscription.callback('delete', { _id: 'org-a' });
      view.unmount();
    });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('does not subscribe for personal, missing auth, MFA or missing identity', async () => {
    const client = createClient();
    select('personal', true);
    mount(client);
    expect(transport.subscriptions).toHaveLength(0);
    await act(async () => {
      useAccessToken.setState({ mfaPending: true });
      select('org-a');
    });
    expect(transport.subscriptions).toHaveLength(0);
    await act(async () => {
      useAccessToken.setState({ mfaPending: false });
      useUser.setState({ currentUser: null });
    });
    expect(transport.subscriptions).toHaveLength(0);
    await act(async () => {
      useAccessToken.setState({ accessToken: null });
      useUser.setState({ currentUser: { id: 'viewer' } as IUserDocument });
    });
    expect(transport.subscriptions).toHaveLength(0);
  });

  it('invalidates a deleted org without installing unrestricted catalog data', async () => {
    const client = createClient();
    seed(client);
    const original = client.getQueryData(catalogQueryKey('org-a'));
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    mount(client);
    await emit(transport.subscriptions[0], 'delete');
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({
      queryKey: catalogQueryKey('org-a'),
      exact: true,
      refetchType: 'active',
    });
    expect(client.getQueryData(catalogQueryKey('org-a'))).toBe(original);
    expect(client.getQueryState(catalogQueryKey('org-a'))?.isInvalidated).toBe(true);
  });

  it('does not install an older initial snapshot received after a newer live policy event', async () => {
    const client = createClient();
    seed(client);
    const latest = catalog('authoritative-new-policy');
    const fetch = vi.fn(async () => latest);
    mount(client, fetch);
    const subscription = transport.subscriptions[0];
    await emit(subscription, 'update', { allowedModels: ['authoritative-new-policy'] });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await emit(subscription, 'insert', { allowedModels: ['obsolete-snapshot'] });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(client.getQueryData(catalogQueryKey('org-a'))).toEqual(latest);
  });

  it.each([{ allowedProviders: ['retired-provider'] }, { allowedTools: [1] }, 'malformed', []])(
    'refreshes when a stale or malformed raw policy changes: %j',
    async policy => {
      const client = createClient();
      seed(client);
      const fetch = vi.fn(async () => catalog('fresh'));
      mount(client, fetch);
      const subscription = transport.subscriptions[0];
      await emit(subscription, 'insert', { allowedTools: [] });
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      await emit(subscription, 'update', policy);
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    }
  );

  it.each(['save', 'reset'] as const)(
    'invalidates only the edited org after %s, even while another org is selected',
    async method => {
      const client = createClient();
      seed(client);
      const cancel = vi.spyOn(client, 'cancelQueries');
      const invalidate = vi.spyOn(client, 'invalidateQueries');
      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      );
      const { result } = renderHook(
        () => ({ save: useSaveOrgModelPolicy('org-b'), reset: useResetOrgModelPolicy('org-b') }),
        { wrapper }
      );
      await act(async () => {
        if (method === 'save')
          await result.current.save.mutateAsync({ allowedProviders: null, allowedModels: null, allowedTools: null });
        else await result.current.reset.mutateAsync();
      });
      expect(cancel).toHaveBeenCalledExactlyOnceWith({ queryKey: catalogQueryKey('org-b'), exact: true });
      expect(invalidate).toHaveBeenCalledExactlyOnceWith({
        queryKey: catalogQueryKey('org-b'),
        exact: true,
        refetchType: 'active',
      });
      expect(client.getQueryState(catalogQueryKey('org-a'))?.isInvalidated).toBe(false);
      expect(client.getQueryState(catalogQueryKey(null))?.isInvalidated).toBe(false);
    }
  );
});

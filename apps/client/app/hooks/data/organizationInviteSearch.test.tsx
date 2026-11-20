import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InviteType } from '@bike4mind/common';
import { useAcceptDocument, useCancelInvite, useDeleteInvite, useRefuseDocument, useShareDocument } from './invites';

const mocks = vi.hoisted(() => ({ share: vi.fn(), remove: vi.fn(), accept: vi.fn(), refuse: vi.fn() }));
vi.mock('@client/app/utils/invitesAPICalls', () => ({
  shareDocument: mocks.share,
  acceptDocument: mocks.accept,
  refuseDocument: mocks.refuse,
}));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { delete: mocks.remove } }));

beforeEach(() => {
  mocks.share.mockReset().mockResolvedValue({});
  mocks.remove.mockReset().mockResolvedValue({});
  mocks.accept.mockReset().mockResolvedValue({ type: InviteType.Organization, documentId: 'organization' });
  mocks.refuse.mockReset().mockResolvedValue({});
});

function prepare() {
  const client = new QueryClient();
  const organizationSearch = ['users', { search: 'candidate', pendingInviteOrganizationId: 'organization' }];
  const otherSearch = ['users', { search: 'candidate', pendingInviteOrganizationId: 'other' }];
  const normalSearch = ['users', { search: 'candidate' }];
  client.setQueryData(organizationSearch, { users: [] });
  client.setQueryData(otherSearch, { users: [] });
  client.setQueryData(normalSearch, { users: [] });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, organizationSearch, otherSearch, normalSearch, wrapper };
}

describe('organization invitation search refresh', () => {
  it('invalidates the matching picker context after creating an invite', async () => {
    const { client, organizationSearch, otherSearch, wrapper } = prepare();
    const { result } = renderHook(() => useShareDocument({ onSuccess: () => undefined }), { wrapper });
    await result.current.mutateAsync({
      id: 'organization',
      type: InviteType.Organization,
      recipients: ['candidate'],
      permissions: ['read'],
    });
    expect(client.getQueryState(organizationSearch)?.isInvalidated).toBe(true);
    expect(client.getQueryState(otherSearch)?.isInvalidated).toBe(false);
  });

  it('invalidates the matching picker context after cancelling an invite', async () => {
    const { client, organizationSearch, otherSearch, wrapper } = prepare();
    const { result } = renderHook(() => useCancelInvite({}), { wrapper });
    await result.current.mutateAsync({
      id: 'organization',
      type: InviteType.Organization,
      email: 'candidate@example.test',
    });
    expect(client.getQueryState(organizationSearch)?.isInvalidated).toBe(true);
    expect(client.getQueryState(otherSearch)?.isInvalidated).toBe(false);
  });

  it('invalidates the matching picker context after accepting an organization invite', async () => {
    const { client, organizationSearch, otherSearch, wrapper } = prepare();
    const { result } = renderHook(() => useAcceptDocument({ onSettled: () => {} }), { wrapper });
    await result.current.mutateAsync('invite');
    expect(client.getQueryState(organizationSearch)?.isInvalidated).toBe(true);
    expect(client.getQueryState(otherSearch)?.isInvalidated).toBe(false);
  });

  it('refreshes organization picker contexts after refusal without invalidating normal user searches', async () => {
    const { client, organizationSearch, otherSearch, normalSearch, wrapper } = prepare();
    const { result } = renderHook(() => useRefuseDocument({ onSettled: () => {} }), { wrapper });
    await result.current.mutateAsync('invite');
    expect(client.getQueryState(organizationSearch)?.isInvalidated).toBe(true);
    expect(client.getQueryState(otherSearch)?.isInvalidated).toBe(true);
    expect(client.getQueryState(normalSearch)?.isInvalidated).toBe(false);
  });

  it('refreshes organization picker contexts after deletion even with a custom success callback', async () => {
    const { client, organizationSearch, otherSearch, normalSearch, wrapper } = prepare();
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useDeleteInvite({ onSuccess }), { wrapper });
    await result.current.mutateAsync({ id: 'invite' });
    expect(client.getQueryState(organizationSearch)?.isInvalidated).toBe(true);
    expect(client.getQueryState(otherSearch)?.isInvalidated).toBe(true);
    expect(client.getQueryState(normalSearch)?.isInvalidated).toBe(false);
    expect(onSuccess).toHaveBeenCalledOnce();
  });
});

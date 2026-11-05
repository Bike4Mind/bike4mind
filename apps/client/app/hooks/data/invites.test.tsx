import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InviteType, IInviteDocumentWithDetails } from '@bike4mind/common';
import { useGetUserInvites, useRespondToInvites } from './invites';

const { mockPost, mockToast } = vi.hoisted(() => ({
  mockPost: vi.fn(),
  mockToast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock('@client/app/utils/invitesAPICalls', () => ({ fetchUserInvites: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: mockPost } }));
vi.mock('sonner', () => ({ toast: mockToast }));

const invite = (id: string, expiresAt?: Date) => ({ id, expiresAt }) as unknown as IInviteDocumentWithDetails;

describe('useGetUserInvites', () => {
  it('drops expired invites, including ones the websocket writes into the cache', async () => {
    const queryClient = new QueryClient();
    // Seeded as the InboxContext websocket callback would: straight into the cache, no fetch.
    queryClient.setQueryData(
      ['invites', 'inbox'],
      [invite('expired', new Date(Date.now() - 1000)), invite('future', new Date(Date.now() + 60_000)), invite('none')]
    );
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useGetUserInvites(''), { wrapper });

    await waitFor(() => expect(result.current.data?.map(i => i.id)).toEqual(['future', 'none']));
  });
});

describe('useRespondToInvites', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('refreshes organization membership caches after a bulk accept', async () => {
    mockPost.mockResolvedValueOnce({
      data: {
        okCount: 1,
        results: [
          {
            id: 'invite',
            ok: true,
            type: InviteType.Organization,
            invite: { documentId: 'organization' },
          },
        ],
      },
    });
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useRespondToInvites(), { wrapper });
    await result.current.mutateAsync({ action: 'accept', ids: ['invite'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['organizations', 'organization'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['users', 'organization', 'organization'] });
    expect(invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['users'], predicate: expect.any(Function) })
    );
  });

  it('reports the committed chunk when a later chunk fails in transport', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `i${i}`);
    mockPost
      .mockImplementationOnce(async (_url: string, body: { ids: string[] }) => ({
        data: { okCount: body.ids.length, results: body.ids.map(id => ({ id, ok: true })) },
      }))
      .mockRejectedValueOnce(new Error('network'));
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useRespondToInvites(), { wrapper });
    await result.current.mutateAsync({ action: 'accept', ids });

    await waitFor(() => expect(mockToast.warning).toHaveBeenCalledWith('100 of 150 document shares accepted'));
    expect(mockToast.error).toHaveBeenCalledWith('Failed to accept the remaining shared documents');
  });
});

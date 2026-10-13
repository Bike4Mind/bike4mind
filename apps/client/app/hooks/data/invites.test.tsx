import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IInviteDocumentWithDetails } from '@bike4mind/common';
import { useGetUserInvites } from './invites';

vi.mock('@client/app/utils/invitesAPICalls', () => ({ fetchUserInvites: vi.fn() }));

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

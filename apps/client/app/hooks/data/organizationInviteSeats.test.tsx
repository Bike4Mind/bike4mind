import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useOrganizationInvites, useOrganizationSeats } from './organizations';

const { get, organizationUsers } = vi.hoisted(() => ({ get: vi.fn(), organizationUsers: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get } }));
vi.mock('./user', () => ({ useGetOrganizationUsers: organizationUsers }));

function createWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  get.mockReset();
  organizationUsers.mockReset();
  organizationUsers.mockReturnValue({ data: [{ id: 'member' }, { id: 'owner' }] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('organization invitation seats', () => {
  it('counts external pending recipients and excludes expired or exhausted invitations', async () => {
    get.mockImplementation(async (url: string) => ({
      data: url.endsWith('/invites')
        ? [
            { id: 'open', remaining: 2, recipients: { pending: ['one@example.test', 'two@example.test'] } },
            { id: 'closed', remaining: 0, recipients: { pending: ['closed@example.test'] } },
            {
              id: 'expired',
              remaining: 1,
              expiresAt: '2000-01-01T00:00:00Z',
              recipients: { pending: ['expired@example.test'] },
            },
          ]
        : { id: 'organization', seats: 5 },
    }));

    const { result } = renderHook(() => useOrganizationSeats('organization'), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.pendingSeats).toBe(2);
    });
    expect(result.current.currentSeats).toBe(4);
    expect(result.current.availableSeats).toBe(1);
    expect(get).toHaveBeenCalledWith('/api/organizations/organization/invites');
  });

  it('drops a cached invitation after expiry on rerender without refetching', async () => {
    const now = new Date('2026-11-05T00:00:00Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    get.mockResolvedValue({
      data: [
        {
          id: 'expiring',
          remaining: 1,
          expiresAt: '2026-11-05T00:01:00Z',
          recipients: { pending: ['one@example.test'] },
        },
      ],
    });
    const { result, rerender } = renderHook(() => useOrganizationInvites('organization'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    vi.setSystemTime(new Date(now.getTime() + 60_000));
    rerender();

    expect(result.current.data).toEqual([]);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('does not request invitations without an organization', () => {
    renderHook(() => useOrganizationInvites(undefined), { wrapper: createWrapper() });
    expect(get).not.toHaveBeenCalled();
  });
});

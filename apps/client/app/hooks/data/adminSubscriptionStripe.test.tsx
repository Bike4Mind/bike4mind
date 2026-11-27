import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { useAdminSubscriptionStripe } from './adminSubscriptionDetail';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get } }));

const ID = 'a'.repeat(24);
const PATH = `/api/admin/subscriptions/${ID}/stripe`;

const setup = (enabled: boolean) => {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useAdminSubscriptionStripe(ID, { enabled }), { wrapper });
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe('useAdminSubscriptionStripe', () => {
  it('makes no request when disabled (a comp row)', () => {
    setup(false);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('does not retry a 502 from Stripe', async () => {
    mocks.get.mockRejectedValue(new AxiosError('bad gateway', '502', undefined, undefined, { status: 502 } as never));
    const { result } = setup(true);
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it('sends fresh=1 only from refetchFresh', async () => {
    mocks.get.mockResolvedValue({ data: { stripeConfigured: false } });
    const { result } = setup(true);
    await waitFor(() => expect(result.current.data).toEqual({ stripeConfigured: false }));
    expect(mocks.get).toHaveBeenLastCalledWith(PATH, { params: undefined });
    act(() => result.current.refetchFresh());
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    expect(mocks.get).toHaveBeenLastCalledWith(PATH, { params: { fresh: 1 } });
  });
});

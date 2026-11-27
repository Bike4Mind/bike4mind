import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '../../utils/themes';
import type { SeatPlan } from '@server/subscriptions/seatPlan';
import { CREDIT_OFFER_SURFACES, CreditOfferActions } from './CreditOfferActions';

const { fetchSeat, trackUpsell } = vi.hoisted(() => ({
  fetchSeat: vi.fn<() => Promise<SeatPlan | null>>(),
  trackUpsell: vi.fn(),
}));

vi.mock('@client/app/utils/funnelEvents', () => ({ trackUpsell }));
vi.mock('@client/app/components/Credits/AccountSelector', () => ({
  useSelectedAccount: <T,>(selector: (state: { selectedAccount: { id: string; personal: boolean } }) => T) =>
    selector({ selectedAccount: { id: 'user-1', personal: true } }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: { name: 'Team member' } }) }));
vi.mock('@client/app/hooks/data/organizations', () => ({ useGetOrganization: () => ({ data: undefined }) }));
vi.mock('@client/app/hooks/data/subscriptions', () => ({
  useGetSubscriptions: () => ({ data: [], isPending: false }),
  // Real query lifecycle: the component must handle a pending lookup before it knows whether a seat exists.
  useGetSeatPlan: () => useQuery({ queryKey: ['pending-seat-test'], queryFn: fetchSeat, retry: false }),
}));
vi.mock('./SessionCreditsButtons', () => ({
  SECONDARY_CREDIT_BUTTON_PROPS: {},
  SubscribeButton: ({ label, onClick }: { label: string; onClick?: () => void }) => (
    <button onClick={onClick}>{label}</button>
  ),
  SessionCreditsButton: ({ label, onClick }: { label: string; onClick?: () => void }) => (
    <button onClick={onClick}>{label}</button>
  ),
}));

const clients = new Set<QueryClient>();
const theme = extendTheme({ ...getThemeConfig() });

function show(moment: 'low' | 'out') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.add(client);
  render(
    <QueryClientProvider client={client}>
      <CssVarsProvider theme={theme}>
        <CreditOfferActions
          moment={moment}
          surface={
            moment === 'low' ? CREDIT_OFFER_SURFACES.lowCreditsWarning : CREDIT_OFFER_SURFACES.outOfCreditsBanner
          }
        />
      </CssVarsProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  fetchSeat.mockReset();
  trackUpsell.mockClear();
});

afterEach(() => {
  cleanup();
  clients.forEach(client => client.clear());
  clients.clear();
});

describe('credit offers while the seat query is pending', () => {
  it.each(['low', 'out'] as const)('withholds Pro until a %s credit offer resolves to a Team seat', async moment => {
    const seat = Promise.withResolvers<SeatPlan | null>();
    fetchSeat.mockReturnValue(seat.promise);
    show(moment);

    expect(screen.queryByRole('button', { name: 'Get Pro' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Top up' })).toBeEnabled();
    expect(trackUpsell).not.toHaveBeenCalled();

    await act(async () => {
      seat.resolve({ organizationId: 'org-1', organizationName: 'Acme', planName: 'Team' });
    });
    await waitFor(() =>
      expect(trackUpsell).toHaveBeenCalledWith('impression', expect.objectContaining({ plan: 'credit_pack' }))
    );
    expect(screen.queryByRole('button', { name: 'Get Pro' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Top up' })).toBeEnabled();
    expect(trackUpsell).not.toHaveBeenCalledWith('impression', expect.objectContaining({ plan: 'Professional' }));
  });

  it.each(['low', 'out'] as const)('offers Pro after a %s lookup confirms there is no Team seat', async moment => {
    const seat = Promise.withResolvers<SeatPlan | null>();
    fetchSeat.mockReturnValue(seat.promise);
    show(moment);
    expect(screen.queryByRole('button', { name: 'Get Pro' })).toBeNull();

    await act(async () => {
      seat.resolve(null);
    });
    expect(await screen.findByRole('button', { name: 'Get Pro' })).toBeEnabled();
    expect(trackUpsell).toHaveBeenCalledWith('impression', expect.objectContaining({ plan: 'Professional' }));
  });

  it.each(['low', 'out'] as const)(
    'preserves the documented Free/Pro fallback after a %s lookup fails',
    async moment => {
      const seat = Promise.withResolvers<SeatPlan | null>();
      fetchSeat.mockReturnValue(seat.promise);
      show(moment);
      expect(screen.queryByRole('button', { name: 'Get Pro' })).toBeNull();

      await act(async () => {
        seat.reject(new Error('Seat lookup failed'));
      });
      expect(await screen.findByRole('button', { name: 'Get Pro' })).toBeEnabled();
      expect(trackUpsell).toHaveBeenCalledWith('impression', expect.objectContaining({ plan: 'Professional' }));
    }
  );
});

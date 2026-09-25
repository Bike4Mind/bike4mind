import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import LakeOwnershipOffersBanner from './LakeOwnershipOffersBanner';

const acceptMutate = vi.fn();
const declineMutate = vi.fn();
let offersState: {
  data?: {
    id: string;
    dataLakeId: string;
    lakeName: string;
    offeredByName?: string;
    expiresAt: Date;
    gate?: { requiredUserTag?: string; requiredEntitlement?: string };
  }[];
  isLoading: boolean;
};

vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useOwnLakeOwnershipOffers: () => offersState,
  useAcceptLakeOwnershipOffer: () => ({ mutate: acceptMutate, isPending: false }),
  useDeclineLakeOwnershipOffer: () => ({ mutate: declineMutate, isPending: false }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const offer = (over: Partial<NonNullable<typeof offersState.data>[number]> = {}) => ({
  id: 'o1',
  dataLakeId: 'lake1',
  lakeName: 'Sales Intelligence',
  offeredByName: 'Olive Owner',
  expiresAt: new Date('2026-10-01T00:00:00Z'),
  ...over,
});

describe('LakeOwnershipOffersBanner', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders nothing when the caller has no pending offers', () => {
    offersState = { data: [], isLoading: false };
    render(<LakeOwnershipOffersBanner />, { wrapper: Wrapper });
    expect(screen.queryByTestId('lake-ownership-offers-banner')).not.toBeInTheDocument();
  });

  it('names the offerer and the lake, and says the instructions will apply', () => {
    offersState = { data: [offer()], isLoading: false };
    render(<LakeOwnershipOffersBanner />, { wrapper: Wrapper });
    const alert = screen.getByTestId('lake-ownership-offer-o1');
    expect(alert).toHaveTextContent(/Olive Owner/);
    expect(alert).toHaveTextContent(/Sales Intelligence/);
    expect(alert).toHaveTextContent(/instructions will apply to your chats/i);
  });

  it('discloses the content gate that accepting bypasses', () => {
    offersState = { data: [offer({ gate: { requiredUserTag: 'phi' } })], isLoading: false };
    render(<LakeOwnershipOffersBanner />, { wrapper: Wrapper });
    const note = screen.getByTestId('lake-ownership-offer-gate-o1');
    expect(note).toHaveTextContent(/phi/);
    expect(note).toHaveTextContent(/overrides that gate/i);
  });

  it('accepts against the offer and its lake', async () => {
    offersState = { data: [offer()], isLoading: false };
    render(<LakeOwnershipOffersBanner />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('lake-ownership-offer-accept-btn'));
    expect(acceptMutate).toHaveBeenCalledWith({ offerId: 'o1', dataLakeId: 'lake1' });
  });

  it('declines against the offer alone', async () => {
    offersState = { data: [offer()], isLoading: false };
    render(<LakeOwnershipOffersBanner />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('lake-ownership-offer-decline-btn'));
    expect(declineMutate).toHaveBeenCalledWith({ offerId: 'o1' });
  });
});

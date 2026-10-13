import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '../../utils/themes';

vi.mock('./SessionCreditsButtons', () => ({
  SubscribeButton: ({ label }: { label?: string }) => <button data-testid="session-subscribe-btn">{label}</button>,
  SessionCreditsButton: ({ secondary, label }: { secondary?: boolean; label?: string }) => (
    <button data-testid="session-credits-btn" data-secondary={String(!!secondary)}>
      {label}
    </button>
  ),
}));

const { accountRef, orgRef, subscriptionsRef } = vi.hoisted(() => ({
  accountRef: { current: null as null | { id: string; personal: boolean } },
  orgRef: { current: undefined as undefined | { name: string; billingContact?: string } },
  subscriptionsRef: { current: [] as Array<{ status: string }> },
}));
vi.mock('@client/app/components/Credits/AccountSelector', () => ({
  useSelectedAccount: (selector: (s: { selectedAccount: unknown }) => unknown) =>
    selector({ selectedAccount: accountRef.current }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { name: 'Sam Member', username: 'sam' } }),
}));
vi.mock('@client/app/hooks/data/organizations', () => ({
  useGetOrganization: () => ({ data: orgRef.current }),
}));
vi.mock('@client/app/hooks/data/subscriptions', () => ({
  useGetSubscriptions: () => ({ data: subscriptionsRef.current }),
}));
vi.mock('./useProCreditOffer', () => ({
  useProCreditOffer: () => ({ name: 'Professional', credits: 50000, priceLabel: '$30' }),
}));

import { CreditOfferActions, buildAdminRequestMessage } from './CreditOfferActions';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderActions = (moment: 'low' | 'out') =>
  render(
    <CssVarsProvider theme={appTheme}>
      <CreditOfferActions moment={moment} />
    </CssVarsProvider>
  );

beforeEach(() => {
  accountRef.current = { id: 'u1', personal: true };
  orgRef.current = undefined;
  subscriptionsRef.current = [];
});

describe('CreditOfferActions', () => {
  it('leads with the Pro plan from plan data and keeps the pack secondary', () => {
    renderActions('low');
    expect(screen.getByTestId('session-subscribe-btn')).toHaveTextContent('Subscribe to Professional');
    expect(screen.getByTestId('session-credits-btn')).toHaveAttribute('data-secondary', 'true');
    expect(screen.getByTestId('credit-offer-pitch')).toHaveTextContent('$30/mo for 50,000 credits every month');
    expect(screen.queryByTestId('credit-offer-ask-admin-btn')).toBeNull();
  });

  it('makes no better-value claim: plan credits and packs sell at the same per-credit rate', () => {
    renderActions('out');
    expect(screen.getByTestId('credit-offer-pitch')).not.toHaveTextContent(/better value/i);
    expect(screen.getByTestId('session-credits-btn')).toHaveTextContent('Buy a credit pack');
  });

  it('offers a subscriber only a credit pack, never the plan they already hold', () => {
    subscriptionsRef.current = [{ status: 'active' }];
    renderActions('out');
    expect(screen.queryByTestId('session-subscribe-btn')).toBeNull();
    expect(screen.queryByTestId('credit-offer-pitch')).toBeNull();
    expect(screen.getByTestId('session-credits-btn')).toHaveAttribute('data-secondary', 'false');
  });

  it('still pitches the plan when the only subscription has ended', () => {
    subscriptionsRef.current = [{ status: 'canceled' }];
    renderActions('low');
    expect(screen.getByTestId('session-subscribe-btn')).toBeInTheDocument();
  });

  it('gives org members Ask your admin instead of purchase buttons, copying the message without a contact email', async () => {
    accountRef.current = { id: 'org1', personal: false };
    orgRef.current = { name: 'Acme', billingContact: 'Jane Doe' };
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderActions('out');
    expect(screen.queryByTestId('session-subscribe-btn')).toBeNull();
    fireEvent.click(screen.getByTestId('credit-offer-ask-admin-btn'));

    await waitFor(() => expect(screen.getByTestId('credit-offer-ask-admin-btn')).toHaveTextContent('Message copied'));
    expect(writeText).toHaveBeenCalledWith(buildAdminRequestMessage('Acme', 'Sam Member'));
  });
});

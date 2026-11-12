import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '../../utils/themes';

vi.mock('./SessionCreditsButtons', () => ({
  SECONDARY_CREDIT_BUTTON_PROPS: { variant: 'outlined', color: 'neutral' },
  SubscribeButton: ({ label = 'Subscribe', onClick }: { label?: string; onClick?: () => void }) => (
    <button data-testid="session-subscribe-btn" onClick={onClick}>
      {label}
    </button>
  ),
  SessionCreditsButton: ({
    secondary,
    label = 'Add Credits',
    onClick,
  }: {
    secondary?: boolean;
    label?: string;
    onClick?: () => void;
  }) => (
    <button data-testid="session-credits-btn" data-secondary={String(!!secondary)} onClick={onClick}>
      {label}
    </button>
  ),
}));

const { trackUpsell } = vi.hoisted(() => ({ trackUpsell: vi.fn() }));
vi.mock('@client/app/utils/funnelEvents', () => ({ trackUpsell }));

const { accountRef, orgRef, subscriptionsRef, pendingRef } = vi.hoisted(() => ({
  accountRef: { current: null as null | { id: string; personal: boolean } },
  orgRef: { current: undefined as undefined | { name: string; billingContact?: string } },
  subscriptionsRef: { current: [] as Array<{ status: string }> },
  pendingRef: { current: false },
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
  useGetSubscriptions: () => ({
    data: pendingRef.current ? undefined : subscriptionsRef.current,
    isPending: pendingRef.current,
  }),
}));

import { CreditOfferActions, CreditOfferActionsView, buildAdminRequestMessage } from './CreditOfferActions';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderActions = (moment: 'low' | 'out') =>
  render(
    <CssVarsProvider theme={appTheme}>
      <CreditOfferActions moment={moment} surface="test_surface" />
    </CssVarsProvider>
  );

beforeEach(() => {
  accountRef.current = { id: 'u1', personal: true };
  orgRef.current = undefined;
  subscriptionsRef.current = [];
  pendingRef.current = false;
  trackUpsell.mockClear();
});

describe('CreditOfferActions upsell tracking', () => {
  it('reports an impression of the Pro offer to an unsubscribed account', () => {
    renderActions('low');
    expect(trackUpsell).toHaveBeenCalledWith('impression', {
      surface: 'test_surface',
      trigger: 'low_balance',
      plan: 'Professional',
    });
  });

  it('reports a subscriber as seeing the credit pack, not the plan', () => {
    subscriptionsRef.current = [{ status: 'active' }];
    renderActions('out');
    expect(trackUpsell).toHaveBeenCalledWith('impression', {
      surface: 'test_surface',
      trigger: 'insufficient_credits',
      plan: 'credit_pack',
    });
  });

  it('waits for the subscription lookup before reporting an impression', () => {
    pendingRef.current = true;
    renderActions('low');
    expect(trackUpsell).not.toHaveBeenCalled();
  });

  it('reports nothing for an org member, whose only action is Ask your admin', () => {
    accountRef.current = { id: 'org1', personal: false };
    renderActions('out');
    expect(trackUpsell).not.toHaveBeenCalled();
  });

  it('reports which offer was clicked', () => {
    renderActions('out');
    fireEvent.click(screen.getByTestId('session-subscribe-btn'));
    expect(trackUpsell).toHaveBeenCalledWith('click', {
      surface: 'test_surface',
      trigger: 'insufficient_credits',
      plan: 'Professional',
    });
    fireEvent.click(screen.getByTestId('session-credits-btn'));
    expect(trackUpsell).toHaveBeenCalledWith('click', {
      surface: 'test_surface',
      trigger: 'insufficient_credits',
      plan: 'credit_pack',
    });
  });

  it('sends nothing from a preview rendered without a surface', () => {
    render(
      <CssVarsProvider theme={appTheme}>
        <CreditOfferActionsView moment="out" account={{ kind: 'unsubscribed' }} />
      </CssVarsProvider>
    );
    fireEvent.click(screen.getByTestId('session-subscribe-btn'));
    expect(trackUpsell).not.toHaveBeenCalled();
  });
});

describe('CreditOfferActions', () => {
  it('leads with the Pro plan from plan data and keeps the pack secondary', () => {
    renderActions('low');
    expect(screen.getByTestId('session-subscribe-btn')).toHaveTextContent(/^Get Pro$/);
    expect(screen.getByTestId('session-credits-btn')).toHaveAttribute('data-secondary', 'true');
    expect(screen.queryByTestId('credit-offer-ask-admin-btn')).toBeNull();
  });

  it('offers Top up and Get Pro once credits are out', () => {
    renderActions('out');
    const buttons = screen.getAllByRole('button');
    expect(buttons.map(b => b.getAttribute('data-testid'))).toEqual(['session-credits-btn', 'session-subscribe-btn']);
    expect(screen.getByTestId('session-credits-btn')).toHaveTextContent('Top up');
  });

  it('offers a subscriber only a credit pack, never the plan they already hold', () => {
    subscriptionsRef.current = [{ status: 'active' }];
    renderActions('out');
    expect(screen.queryByTestId('session-subscribe-btn')).toBeNull();
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

  it('keeps the one action secondary on a low balance, primary once credits are out', () => {
    subscriptionsRef.current = [{ status: 'active' }];
    const { unmount } = renderActions('low');
    expect(screen.getByTestId('session-credits-btn')).toHaveAttribute('data-secondary', 'true');
    unmount();

    accountRef.current = { id: 'org1', personal: false };
    orgRef.current = { name: 'Acme' };
    const low = renderActions('low');
    expect(screen.getByTestId('credit-offer-ask-admin-btn').className).toMatch(/variantOutlined/);
    low.unmount();
    renderActions('out');
    expect(screen.getByTestId('credit-offer-ask-admin-btn').className).toMatch(/variantSolid/);
  });
});

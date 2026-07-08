import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '../../utils/themes';

// SessionCreditsButton mounts the purchase CreditsModal (and SessionCreditsButtons
// also imports SubscriptionModal); both pull a deep data/context chain not wired in
// vitest. Stub them to lightweight open-state reveals so we can assert the CTA opens
// the purchase modal without dragging in react-query / UserContext.
vi.mock('../subscription/CreditsModal', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="credits-modal-open" /> : null),
}));
vi.mock('../subscription/SubscriptionModal', () => ({
  default: () => null,
}));

// useSelectedAccount lives in AccountSelector, which transitively imports LLMContext /
// UserContext / org data hooks. Mock just the selector so we can drive personal vs. org
// without the deep chain. accountRef is hoisted so the factory can read it lazily.
const { accountRef } = vi.hoisted(() => ({
  accountRef: { current: null as null | { personal: boolean } },
}));
vi.mock('@client/app/components/Credits/AccountSelector', () => ({
  useSelectedAccount: (selector: (s: { selectedAccount: null | { personal: boolean } }) => unknown) =>
    selector({ selectedAccount: accountRef.current }),
}));

import { InsufficientCreditsNotice } from './InsufficientCreditsNotice';

const appTheme = extendTheme({ ...getThemeConfig() });

const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const MESSAGE =
  "You're out of credits. This request needs about 500 credits, but only 120 are available. Add credits to keep going.";
const ORG_MESSAGE =
  'Your organization "Acme" is out of credits. This request needs about 500 credits, but only 0 are available. Contact your organization administrator to add more credits.';

beforeEach(() => {
  accountRef.current = null; // default: personal account (can purchase)
});

describe('InsufficientCreditsNotice', () => {
  it('renders the plain-language message', () => {
    render(
      <TestWrapper>
        <InsufficientCreditsNotice message={MESSAGE} />
      </TestWrapper>
    );

    expect(screen.getByTestId('insufficient-credits-notice')).toBeInTheDocument();
    expect(screen.getByTestId('insufficient-credits-message')).toHaveTextContent(MESSAGE);
  });

  it('renders Subscribe + Add Credits CTAs for a personal account', () => {
    render(
      <TestWrapper>
        <InsufficientCreditsNotice message={MESSAGE} />
      </TestWrapper>
    );

    expect(screen.getByTestId('session-credits-btn')).toHaveTextContent('Add Credits');
    expect(screen.getByTestId('session-subscribe-btn')).toHaveTextContent('Subscribe');
  });

  it('opens the purchase modal when the CTA is clicked', () => {
    render(
      <TestWrapper>
        <InsufficientCreditsNotice message={MESSAGE} />
      </TestWrapper>
    );

    expect(screen.queryByTestId('credits-modal-open')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('session-credits-btn'));
    expect(screen.getByTestId('credits-modal-open')).toBeInTheDocument();
  });

  it('suppresses the dead-end CTA for an org account (they cannot self-purchase)', () => {
    accountRef.current = { personal: false };
    render(
      <TestWrapper>
        <InsufficientCreditsNotice message={ORG_MESSAGE} />
      </TestWrapper>
    );

    // The message (with admin guidance) still renders, but neither purchase CTA.
    expect(screen.getByTestId('insufficient-credits-message')).toHaveTextContent(ORG_MESSAGE);
    expect(screen.queryByTestId('session-credits-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('session-subscribe-btn')).not.toBeInTheDocument();
  });
});

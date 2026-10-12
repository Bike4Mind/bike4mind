import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '../../utils/themes';

// The offer actions pull in account/org/data hooks; stub them, their own behavior is tested in
// CreditOfferActions.test.tsx. Only that each warning renders them for the right moment is checked here.
vi.mock('./CreditOfferActions', () => ({
  CreditOfferActions: ({ moment }: { moment: string }) => (
    <div data-testid="credit-offer-actions" data-moment={moment} />
  ),
}));

import { CreditsWarning, LowCreditsWarning, NoModelsWarning } from './SessionWarnings';

const appTheme = extendTheme({ ...getThemeConfig() });

const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('NoModelsWarning', () => {
  it('renders nothing when show is false', () => {
    const { container } = render(
      <TestWrapper>
        <NoModelsWarning show={false} />
      </TestWrapper>
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the warning when show is true', () => {
    render(
      <TestWrapper>
        <NoModelsWarning show={true} />
      </TestWrapper>
    );

    expect(screen.getByTestId('session-no-models-warning')).toBeInTheDocument();
    expect(screen.getByTestId('no-models-warning-text')).toBeInTheDocument();
  });

  it('displays the correct warning message', () => {
    render(
      <TestWrapper>
        <NoModelsWarning show={true} />
      </TestWrapper>
    );

    expect(screen.getByTestId('no-models-warning-text')).toHaveTextContent("You don't have access to any AI models.");
    expect(screen.getByText(/contact your administrator/i)).toBeInTheDocument();
  });

  it('offers a retry instead of the permissions message when the model list failed to load', () => {
    const onRetry = vi.fn();
    render(
      <TestWrapper>
        <NoModelsWarning show={true} loadError onRetry={onRetry} />
      </TestWrapper>
    );

    expect(screen.getByTestId('no-models-warning-text')).toHaveTextContent("Couldn't load AI models.");
    expect(screen.queryByText(/contact your administrator/i)).toBeNull();
    fireEvent.click(screen.getByTestId('no-models-retry-btn'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('CreditsWarning', () => {
  it('renders nothing when show is false', () => {
    const { container } = render(
      <TestWrapper>
        <CreditsWarning show={false} />
      </TestWrapper>
    );
    expect(container.firstChild).toBeNull();
  });

  it('says the balance is out and renders the out-of-credits offer', () => {
    render(
      <TestWrapper>
        <CreditsWarning show />
      </TestWrapper>
    );
    expect(screen.getByTestId('credits-warning-text')).toHaveTextContent('Out of Credits');
    const actions = screen.getByTestId('credits-warning-actions');
    expect(within(actions).getByTestId('credit-offer-actions')).toHaveAttribute('data-moment', 'out');
  });
});

describe('LowCreditsWarning', () => {
  it('shows the remaining balance and can be dismissed', () => {
    const onDismiss = vi.fn();
    render(
      <TestWrapper>
        <LowCreditsWarning show currentCredits={1234} onDismiss={onDismiss} />
      </TestWrapper>
    );
    expect(screen.getByTestId('session-low-credits-warning')).toHaveTextContent('1,234');
    fireEvent.click(screen.getByTestId('low-credits-warning-dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('renders the low-balance offer without covering the message box', () => {
    render(
      <TestWrapper>
        <LowCreditsWarning show currentCredits={500} onDismiss={vi.fn()} />
      </TestWrapper>
    );
    expect(screen.getByTestId('credit-offer-actions')).toHaveAttribute('data-moment', 'low');
    expect(getComputedStyle(screen.getByTestId('session-low-credits-warning')).position).not.toBe('absolute');
  });
});

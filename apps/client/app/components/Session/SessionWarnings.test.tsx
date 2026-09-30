import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '../../utils/themes';

// SessionWarnings imports SessionCreditsButtons which pulls in LLMContext
// (uses @/ alias not in vitest config). Stub the buttons - their own behavior is not under
// test here, only that each warning offers them.
vi.mock('./SessionCreditsButtons', () => ({
  SubscribeButton: () => <button data-testid="session-subscribe-btn" />,
  SessionCreditsButton: ({ secondary }: { secondary?: boolean }) => (
    <button data-testid="session-credits-btn" data-secondary={String(!!secondary)} />
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

  it('says the balance is out and offers both ways back, Subscribe as the primary one', () => {
    render(
      <TestWrapper>
        <CreditsWarning show />
      </TestWrapper>
    );
    expect(screen.getByTestId('credits-warning-text')).toHaveTextContent('Out of Credits');
    const actions = screen.getByTestId('credits-warning-actions');
    expect(within(actions).getByTestId('session-subscribe-btn')).toBeInTheDocument();
    expect(within(actions).getByTestId('session-credits-btn')).toHaveAttribute('data-secondary', 'true');
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
});

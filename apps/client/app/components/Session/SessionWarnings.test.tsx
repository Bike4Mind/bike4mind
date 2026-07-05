import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '../../utils/themes';

// SessionWarnings imports SessionCreditsButtons which pulls in LLMContext
// (uses @/ alias not in vitest config). Mock the buttons - not under test here.
vi.mock('./SessionBottom/SessionCreditsButtons', () => ({
  SubscribeButton: () => null,
  SessionCreditsButton: () => null,
}));

import { NoModelsWarning } from './SessionWarnings';

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
});

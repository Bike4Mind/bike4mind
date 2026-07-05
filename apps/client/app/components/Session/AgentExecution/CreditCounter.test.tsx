import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({
  totalCreditsUsed: undefined as number | undefined,
}));

vi.mock('@client/app/stores/useAgentExecutionStore', () => {
  const selectExecution = () => () => ({ totalCreditsUsed: mocks.totalCreditsUsed });
  const useAgentExecutionStore = (selector: (s: unknown) => unknown) => selector({});
  return { useAgentExecutionStore, selectExecution };
});

import CreditCounter from './CreditCounter';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const EXECUTION_ID = 'exec-credit-1';

describe('CreditCounter', () => {
  beforeEach(() => {
    mocks.totalCreditsUsed = undefined;
  });

  it('renders null when execution is missing from the store', () => {
    const { container } = render(
      <TestWrapper>
        <CreditCounter executionId={EXECUTION_ID} />
      </TestWrapper>
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders 0 credits even on a fresh execution (immediate feedback)', () => {
    mocks.totalCreditsUsed = 0;
    render(
      <TestWrapper>
        <CreditCounter executionId={EXECUTION_ID} />
      </TestWrapper>
    );
    expect(screen.getByTestId(`credit-counter-${EXECUTION_ID}`)).toBeInTheDocument();
    expect(screen.getByText('0 credits')).toBeInTheDocument();
  });

  it('rounds fractional credits and formats with locale thousands separator', () => {
    mocks.totalCreditsUsed = 1234.7;
    render(
      <TestWrapper>
        <CreditCounter executionId={EXECUTION_ID} />
      </TestWrapper>
    );
    expect(screen.getByText('1,235 credits')).toBeInTheDocument();
  });
});

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { AccountCard } from './ProfileMenu';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('ProfileMenu AccountCard - enforceCredits gating', () => {
  it('shows the credit balance chip when showCredits is true', () => {
    render(
      <TestWrapper>
        <AccountCard name="Jane" typeLabel={null} credits={1234} selected onSelect={vi.fn()} showCredits />
      </TestWrapper>
    );

    expect(screen.getByText('1,234')).toBeInTheDocument();
  });

  it('hides the credit balance chip when showCredits is false (enforceCredits off)', () => {
    render(
      <TestWrapper>
        <AccountCard name="Jane" typeLabel={null} credits={1234} selected onSelect={vi.fn()} showCredits={false} />
      </TestWrapper>
    );

    expect(screen.queryByText('1,234')).not.toBeInTheDocument();
    // The rest of the card still renders - only the balance disappears.
    expect(screen.getByText('Jane')).toBeInTheDocument();
  });
});

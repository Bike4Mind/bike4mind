import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { AccountSuspendedNotice } from './AccountSuspendedNotice';

vi.mock('@client/config/general', () => ({
  APP_NAME: 'Test app',
  WEBSITE_URL: 'https://example.com',
  getWebsiteUrl: (path: string) => `https://example.com/${path}`,
}));

const theme = extendTheme({ ...getThemeConfig() });

afterEach(cleanup);

describe('AccountSuspendedNotice', () => {
  it('links to the support page when no support email is configured', () => {
    render(
      <CssVarsProvider theme={theme}>
        <AccountSuspendedNotice category="payment_fraud" />
      </CssVarsProvider>
    );

    const appeal = screen.getByTestId('account-suspended-notice-appeal-link');
    expect(appeal).toHaveAttribute('href', 'https://example.com/support');
    expect(appeal).toHaveAttribute('target', '_blank');
    expect(appeal).toHaveAttribute('rel', 'noopener noreferrer');
    expect(appeal).toHaveTextContent('Appeal');
    expect(screen.getByTestId('account-suspended-notice-message')).toHaveTextContent(
      'you can appeal at https://example.com/support'
    );
  });

  it('prefers the support email when configured', () => {
    render(
      <CssVarsProvider theme={theme}>
        <AccountSuspendedNotice category="payment_fraud" supportEmail="support@example.com" />
      </CssVarsProvider>
    );

    const appeal = screen.getByTestId('account-suspended-notice-appeal-link');
    expect(appeal).toHaveAttribute('href', 'mailto:support@example.com?subject=Suspension%20appeal');
    expect(appeal).toHaveTextContent('Appeal by email');
    expect(screen.getByTestId('account-suspended-notice-message')).toHaveTextContent(
      'you can appeal by emailing support@example.com'
    );
  });
});

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';

import { getThemeConfig } from '@client/app/utils/themes';
import { PrReportPreview } from './PrReportPreview';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('PrReportPreview', () => {
  it('renders a user mention by display name, a group ping by raw id, and an https link', () => {
    render(
      <PrReportPreview
        text={'owed by <@U0WESCARD>, pool <!subteam^S0REVIEWERS>, see <https://x.test/1|#1 Fix>'}
        mentionNames={{ U0WESCARD: 'Wes Carda' }}
        mentionNamesUnavailable={false}
      />,
      { wrapper }
    );

    // Resolved user name is shown, in a mention span (@Wes Carda).
    expect(screen.getByText(/^@Wes Carda$/)).toBeInTheDocument();
    // A group id has no users.info name, so it renders as the raw id in a mention span
    // (@S0REVIEWERS). Pinned to the notifying-form render: a revert to inert `<@S...>`
    // text would not produce this span and this assertion would fail.
    expect(screen.getByText(/^@S0REVIEWERS$/)).toBeInTheDocument();
    // The link is clickable and points where the label says.
    const link = screen.getByRole('link', { name: '#1 Fix' });
    expect(link).toHaveAttribute('href', 'https://x.test/1');
  });

  it('surfaces the degraded-lookup warning', () => {
    render(<PrReportPreview text={'<@U0WESCARD>'} mentionNames={{}} mentionNamesUnavailable={true} />, { wrapper });
    expect(screen.getByText(/name lookup was unavailable/i)).toBeInTheDocument();
  });

  it('never renders a non-http(s) link target as clickable', () => {
    render(
      <PrReportPreview text={'<javascript:alert(1)|Merge me>'} mentionNames={{}} mentionNamesUnavailable={false} />,
      { wrapper }
    );
    // The label survives as inert text; nothing becomes a live link.
    expect(screen.getByText(/Merge me/)).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });
});

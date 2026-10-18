import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import MarketStatusBadge, { marketStatusBadge } from './MarketStatusBadge';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: React.ReactElement) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);

describe('MarketStatusBadge', () => {
  it('shows "Update available (vN -> vM)" for a stale copy', () => {
    wrap(
      <MarketStatusBadge status={{ state: 'stale', importedVersion: 1, latestVersion: 3, locallyModified: false }} />
    );
    expect(screen.getByTestId('market-status-stale')).toHaveTextContent('Update available (v1 -> v3)');
  });

  it('warns when moderators delisted the listing', () => {
    wrap(
      <MarketStatusBadge status={{ state: 'delisted', importedVersion: 2, latestVersion: 2, locallyModified: false }} />
    );
    expect(screen.getByTestId('market-status-delisted')).toHaveTextContent('Delisted by moderators');
  });

  it('says "No longer available" when the author withdrew it', () => {
    wrap(<MarketStatusBadge status={{ state: 'removed', importedVersion: 1, locallyModified: true }} />);
    expect(screen.getByTestId('market-status-removed')).toHaveTextContent('No longer available');
  });

  it('renders nothing for a current copy or a non-imported skill', () => {
    const { container } = wrap(
      <>
        <MarketStatusBadge
          status={{ state: 'current', importedVersion: 1, latestVersion: 1, locallyModified: false }}
        />
        <MarketStatusBadge />
      </>
    );
    expect(container.querySelector('[data-testid^="market-status-"]')).toBeNull();
    expect(marketStatusBadge(undefined)).toBeNull();
  });
});

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, within, cleanup } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { ActiveBriefCard } from './deckChrome';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderCard = () =>
  render(
    <Wrapper>
      <ActiveBriefCard
        name="Austin Food Truck Circuit"
        description="Shortest nightly loop hitting ten hotspots."
        stats={['10 stops']}
        objectiveLine="objective: minimize tour length"
        isDark
      />
    </Wrapper>
  );

afterEach(cleanup);

describe('ActiveBriefCard', () => {
  it('states the brief it is showing', () => {
    renderCard();

    const card = screen.getByTestId('opti-active-brief');
    expect(within(card).getByText('Austin Food Truck Circuit')).toBeInTheDocument();
    expect(within(card).getByText('objective: minimize tour length')).toBeInTheDocument();
  });
});

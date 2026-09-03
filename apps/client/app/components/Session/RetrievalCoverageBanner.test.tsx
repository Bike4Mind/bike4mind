import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';
import { COVERAGE_BANNER_TITLE, COVERAGE_BANNER_BODY } from '@bike4mind/common';
import { RetrievalCoverageBanner } from './RetrievalCoverageBanner';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('RetrievalCoverageBanner', () => {
  it('renders under the testid the app and its e2e checks key on', () => {
    render(
      <Wrapper>
        <RetrievalCoverageBanner />
      </Wrapper>
    );

    expect(screen.getByTestId('retrieval-coverage-warning')).toBeTruthy();
  });

  it('renders the shared title and body copy rather than a local variant', () => {
    render(
      <Wrapper>
        <RetrievalCoverageBanner />
      </Wrapper>
    );

    const banner = screen.getByTestId('retrieval-coverage-warning');
    expect(banner.textContent).toContain(COVERAGE_BANNER_TITLE);
    expect(banner.textContent).toContain(COVERAGE_BANNER_BODY);
  });

  it('warns against reading the answer as proof the library holds nothing else', () => {
    // The load-bearing sentence. The hazard this banner exists for is the confident false negative,
    // not the unanswered question, so a copy edit that drops this clause defeats the feature.
    render(
      <Wrapper>
        <RetrievalCoverageBanner />
      </Wrapper>
    );

    expect(screen.getByTestId('retrieval-coverage-warning').textContent).toContain(
      'do not read it as proof that nothing else in the library is relevant'
    );
  });

  it('lists each reason behind the disclosure when reasons are supplied', () => {
    render(
      <Wrapper>
        <RetrievalCoverageBanner
          reasons={['the 4000-chunk per-turn scan budget was reached', '2 document(s) excluded']}
        />
      </Wrapper>
    );

    const details = screen.getByTestId('retrieval-coverage-reasons');
    expect(details.textContent).toContain('the 4000-chunk per-turn scan budget was reached');
    expect(details.textContent).toContain('2 document(s) excluded');
  });

  it('omits the disclosure entirely when there are no reasons', () => {
    // An empty <details> renders as a bare, clickable "Why the scan was partial" that opens onto
    // nothing. The banner still stands on its own without it.
    render(
      <Wrapper>
        <RetrievalCoverageBanner reasons={[]} />
      </Wrapper>
    );

    expect(screen.queryByTestId('retrieval-coverage-reasons')).toBeNull();
  });
});

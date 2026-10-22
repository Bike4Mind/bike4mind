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

  it('renders the shared one-line copy rather than a local variant', () => {
    render(
      <Wrapper>
        <RetrievalCoverageBanner />
      </Wrapper>
    );

    expect(screen.getByTestId('retrieval-coverage-warning').textContent).toContain(COVERAGE_BANNER_TITLE);
  });

  it('keeps the reasons behind a disclosure that starts closed', () => {
    render(
      <Wrapper>
        <RetrievalCoverageBanner reasons={['More documents matched than one search can cover.']} />
      </Wrapper>
    );

    const disclosure = screen.getByTestId('retrieval-coverage-warning').querySelector('details');
    expect(disclosure).not.toBeNull();
    expect(disclosure?.hasAttribute('open')).toBe(false);
  });

  it('lists each reason inside the disclosure when reasons are supplied', () => {
    render(
      <Wrapper>
        <RetrievalCoverageBanner
          reasons={['More documents matched than one search can cover.', '2 document(s) skipped.']}
        />
      </Wrapper>
    );

    const details = screen.getByTestId('retrieval-coverage-reasons');
    expect(details.textContent).toContain('More documents matched than one search can cover.');
    expect(details.textContent).toContain('2 document(s) skipped.');
  });

  it('warns against reading the answer as proof the library holds nothing else', () => {
    // The load-bearing sentence. The hazard this notice exists for is the confident false negative,
    // not the unanswered question, so a copy edit that drops this clause defeats the feature.
    render(
      <Wrapper>
        <RetrievalCoverageBanner reasons={['One reason.']} />
      </Wrapper>
    );

    expect(screen.getByTestId('retrieval-coverage-reasons').textContent).toContain(COVERAGE_BANNER_BODY);
    expect(COVERAGE_BANNER_BODY).toContain('not proof that nothing else in the library is relevant');
  });

  it('omits the disclosure entirely when there are no reasons', () => {
    // Otherwise a "Details" toggle opens onto nothing. The line still stands on its own.
    render(
      <Wrapper>
        <RetrievalCoverageBanner reasons={[]} />
      </Wrapper>
    );

    expect(screen.queryByTestId('retrieval-coverage-reasons')).toBeNull();
    expect(screen.getByTestId('retrieval-coverage-warning').querySelector('details')).toBeNull();
  });
});

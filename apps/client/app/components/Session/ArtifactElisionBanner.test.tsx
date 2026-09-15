import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';
import { ELISION_BANNER_TITLE, ELISION_BANNER_BODY, ELISION_PUBLISH_BODY } from '@bike4mind/common';
import { ArtifactElisionBanner } from './ArtifactElisionBanner';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

// The surface QA reported broken ("the banner never appeared") had no test at all - only the decision
// helper was covered. These pin the testid and the copy contract; whether to render it is
// shouldWarnElidedArtifact's job and tested with that function.
describe('ArtifactElisionBanner', () => {
  it('renders under the testid the app and its e2e checks key on', () => {
    render(
      <Wrapper>
        <ArtifactElisionBanner />
      </Wrapper>
    );

    expect(screen.getByTestId('artifact-elided-warning')).toBeTruthy();
  });

  it('renders the shared title and body copy rather than a local variant', () => {
    render(
      <Wrapper>
        <ArtifactElisionBanner />
      </Wrapper>
    );

    const banner = screen.getByTestId('artifact-elided-warning');
    expect(banner.textContent).toContain(ELISION_BANNER_TITLE);
    expect(banner.textContent).toContain(ELISION_BANNER_BODY);
  });

  it('tells the reader to check it before sharing', () => {
    // The one piece of copy authored here rather than in the shared constants, so it needs pinning
    // separately - it is what points a reader at the publish gate.
    render(
      <Wrapper>
        <ArtifactElisionBanner />
      </Wrapper>
    );

    expect(screen.getByTestId('artifact-elided-warning').textContent).toContain('Check it before sharing');
  });

  it('does not use the publish-gate wording, which names the shared link', () => {
    // The chat banner and the publish gate deliberately differ: only the gate mentions the /p/ link,
    // because that is the point of no return. Swapping them would be a silent copy regression.
    render(
      <Wrapper>
        <ArtifactElisionBanner />
      </Wrapper>
    );

    expect(screen.getByTestId('artifact-elided-warning').textContent).not.toContain(ELISION_PUBLISH_BODY);
  });
});

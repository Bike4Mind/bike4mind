import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';
import { RetrievalFloorBanner } from './RetrievalFloorBanner';

const appTheme = extendTheme({ ...getThemeConfig() });

describe('RetrievalFloorBanner', () => {
  it('names the configured minimum, the measured one, and the model', () => {
    render(
      <CssVarsProvider theme={appTheme}>
        <RetrievalFloorBanner floorPct={75} measuredPct={58} embeddingModel="text-embedding-3-small" />
      </CssVarsProvider>
    );

    const banner = screen.getByTestId('retrieval-floor-warning');
    expect(banner).toHaveTextContent('No passages were relevant enough');
    expect(banner).toHaveTextContent('scored 75% or higher');
    expect(banner).toHaveTextContent('58% measured for text-embedding-3-small');
  });
});

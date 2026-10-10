import React from 'react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { CapabilityIndicators, MetricIndicators } from './modelIndicators';

const appTheme = extendTheme({ ...getThemeConfig() });

describe('model indicator labels', () => {
  it('gives every capability, cost and speed icon an accessible label', () => {
    const model = { supportsVision: true, can_think: true, supportsTools: true } as ModelInfo;
    render(
      <CssVarsProvider theme={appTheme}>
        <CapabilityIndicators model={model} />
        <MetricIndicators priceTier={{ tier: 'Low', variant: 'green' }} modelSpeed="fast" statsLoading={false} />
      </CssVarsProvider>
    );

    expect(screen.getByTestId('model-indicator-vision')).toHaveAttribute('aria-label', 'Vision');
    expect(screen.getByTestId('model-indicator-thinking')).toHaveAttribute('aria-label', 'Thinking');
    expect(screen.getByTestId('model-indicator-tools')).toHaveAttribute('aria-label', 'Tools');
    expect(screen.getByTestId('model-indicator-low-cost')).toHaveAttribute('aria-label', 'Low cost');
    expect(screen.getByTestId('model-indicator-fast-speed')).toHaveAttribute('aria-label', 'Fast speed');
  });

  it('omits icons for capabilities the model lacks', () => {
    render(
      <CssVarsProvider theme={appTheme}>
        <CapabilityIndicators model={{} as ModelInfo} />
      </CssVarsProvider>
    );
    expect(screen.queryByTestId('model-indicator-vision')).not.toBeInTheDocument();
  });
});

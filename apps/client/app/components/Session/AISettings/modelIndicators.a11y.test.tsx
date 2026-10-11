import React from 'react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CREDITS_PER_USD_COST, type ModelInfo } from '@bike4mind/common';
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

// jsdom has no matchMedia; stub it so only the (hover: none) query matches, as on a phone.
const stubNoHover = () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query === '(hover: none)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  );
};

describe('model indicator tooltips on touch screens', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens the tooltip on tap without letting the tap reach the card underneath', () => {
    stubNoHover();
    const onCardClick = vi.fn();
    render(
      <CssVarsProvider theme={appTheme}>
        <div onClick={onCardClick}>
          <CapabilityIndicators model={{ supportsVision: true } as ModelInfo} />
        </div>
      </CssVarsProvider>
    );

    fireEvent.click(screen.getByTestId('model-indicator-vision'));

    expect(screen.getByRole('tooltip')).toHaveTextContent('Able to understand images');
    expect(onCardClick).not.toHaveBeenCalled();
  });

  it('leaves clicks alone where hover exists', () => {
    const onCardClick = vi.fn();
    render(
      <CssVarsProvider theme={appTheme}>
        <div onClick={onCardClick}>
          <CapabilityIndicators model={{ supportsVision: true } as ModelInfo} />
        </div>
      </CssVarsProvider>
    );

    fireEvent.click(screen.getByTestId('model-indicator-vision'));

    expect(onCardClick).toHaveBeenCalledTimes(1);
  });

  it('shows the credit figure for a priced model when the cost icon is tapped', () => {
    stubNoHover();
    const model = { type: 'text', pricing: { 200000: { input: 3 / 1e6, output: 15 / 1e6 } } } as unknown as ModelInfo;
    render(
      <CssVarsProvider theme={appTheme}>
        <MetricIndicators
          priceTier={{ tier: 'High', variant: 'red' }}
          modelSpeed={null}
          statsLoading={false}
          model={model}
        />
      </CssVarsProvider>
    );

    fireEvent.click(screen.getByTestId('model-indicator-high-cost'));

    const input = (3 * CREDITS_PER_USD_COST).toLocaleString('en-US');
    expect(screen.getByRole('tooltip')).toHaveTextContent(`Premium cost model: ${input} credits per 1M input tokens`);
  });
});

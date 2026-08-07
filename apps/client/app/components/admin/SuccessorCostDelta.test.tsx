import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { SuccessorCostChip, SuccessorCostPanel } from './SuccessorCostDelta';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

// The grok-3-mini -> grok-4.5 case the cost-safety decision was argued from.
const RATES = {
  'grok-3-mini': { input: 0.3, output: 0.5 },
  'grok-4.5': { input: 2, output: 6 },
  'grok-4.5-cheap': { input: 0.1, output: 0.25 },
};

const renderWith = (ui: React.ReactElement) => render(<TestWrapper>{ui}</TestWrapper>);

describe('SuccessorCostChip', () => {
  it('leads with the worse of the two moves on a more expensive successor', () => {
    renderWith(<SuccessorCostChip modelId="grok-3-mini" successorId="grok-4.5" rates={RATES} />);

    // Output rises 12x against input's 6.7x, so output is the headline.
    expect(screen.getByTestId('successor-cost-chip-grok-3-mini')).toHaveTextContent('costs more +1100% (12.0x)');
  });

  it('marks a cheaper successor as no cost increase', () => {
    renderWith(<SuccessorCostChip modelId="grok-3-mini" successorId="grok-4.5-cheap" rates={RATES} />);

    expect(screen.getByTestId('successor-cost-chip-grok-3-mini')).toHaveTextContent('no cost increase');
  });

  it('says so rather than implying free when a rate is missing', () => {
    renderWith(<SuccessorCostChip modelId="grok-3-mini" successorId="unpriced" rates={RATES} />);

    expect(screen.getByTestId('successor-cost-chip-grok-3-mini')).toHaveTextContent('no price on file');
  });

  it('renders nothing without a successor', () => {
    renderWith(<SuccessorCostChip modelId="grok-3-mini" rates={RATES} />);

    expect(screen.queryByTestId('successor-cost-chip-grok-3-mini')).not.toBeInTheDocument();
  });
});

describe('SuccessorCostPanel', () => {
  it('shows both per-MTok rates and both percentages', () => {
    renderWith(<SuccessorCostPanel modelId="grok-3-mini" successorId="grok-4.5" rates={RATES} />);

    const panel = screen.getByTestId('successor-cost-panel');
    expect(panel).toHaveTextContent('costs more');
    expect(panel).toHaveTextContent('$0.300 to $2.00 / MTok (+567% (6.7x))');
    expect(panel).toHaveTextContent('$0.500 to $6.00 / MTok (+1100% (12.0x))');
  });

  it('explains the unpriced case instead of showing a comparison it cannot make', () => {
    renderWith(<SuccessorCostPanel modelId="grok-3-mini" successorId="unpriced" rates={RATES} />);

    const panel = screen.getByTestId('successor-cost-panel');
    expect(panel).toHaveTextContent('no price on file');
    expect(panel).toHaveTextContent('cannot be checked');
  });

  it('renders nothing until a successor is chosen', () => {
    renderWith(<SuccessorCostPanel modelId="grok-3-mini" successorId="" rates={RATES} />);

    expect(screen.queryByTestId('successor-cost-panel')).not.toBeInTheDocument();
  });
});

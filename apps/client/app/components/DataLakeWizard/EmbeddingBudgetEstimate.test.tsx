import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { EmbeddingBudgetEstimate } from './EmbeddingBudgetEstimate';

const { cost } = vi.hoisted(() => ({ cost: { current: 0 } }));

vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: (key: string) =>
    ({ dataLakeEmbeddingSpendEnabled: 'true', dataLakeEmbeddingBudgetPerRunUsd: '5', defaultEmbeddingModel: 'm' })[key],
  useEffectiveEmbeddingModel: () => 'm',
}));
vi.mock('@client/app/utils/embeddingCostEstimate', () => ({
  estimateEmbeddingTokens: () => 1,
  estimateEmbeddingCostUsd: () => cost.current,
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);
const files = [{ name: 'a.txt', size: 1 }];

describe('EmbeddingBudgetEstimate cost formatting', () => {
  it.each([
    [0.00001, '<$0.0001', false],
    [0.00009, '<$0.0001', false],
    [0.0001, '$0.0001', true],
    [0.0123, '$0.0123', true],
  ])('renders a cost of %s as %s', (value, expectedTotal, expectsTilde) => {
    cost.current = value;
    render(<EmbeddingBudgetEstimate files={files} />, { wrapper: Wrapper });
    expect(screen.getByTestId('datalake-estimate-total')).toHaveTextContent(expectedTotal);
    expect(screen.getByTestId('datalake-estimate-line')).toHaveTextContent(
      `Estimated embedding cost: ${expectsTilde ? '~' : ''}${expectedTotal}`
    );
  });

  it('formats the over-budget alert total at $7.00', () => {
    cost.current = 7;
    render(<EmbeddingBudgetEstimate files={files} />, { wrapper: Wrapper });
    expect(screen.getByTestId('datalake-estimate-total')).toHaveTextContent('$7.00');
    expect(screen.getByTestId('datalake-estimate-over-budget-alert')).toHaveTextContent('~$7.00');
  });

  it.each([0, NaN, -1])('renders nothing for a cost of %s', value => {
    cost.current = value;
    render(<EmbeddingBudgetEstimate files={files} />, { wrapper: Wrapper });
    expect(screen.queryByTestId('datalake-estimate-line')).toBeNull();
    expect(screen.queryByTestId('datalake-estimate-over-budget-alert')).toBeNull();
  });
});

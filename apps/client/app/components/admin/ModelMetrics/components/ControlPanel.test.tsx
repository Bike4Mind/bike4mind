import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { ControlPanel } from './ControlPanel';
import { MODEL_METRICS_SEARCH_KEYS } from '../modelMetricsSearch';
import type { ModelMetric } from '../types';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const metric = (model: string, userId: string) => ({ model: { name: model }, session: { userId } }) as ModelMetric;

const renderPanel = (overrides: Partial<React.ComponentProps<typeof ControlPanel>> = {}) => {
  const props = {
    metrics: [metric('model-a', 'user-1'), metric('model-b', 'user-2')],
    modelInfos: [],
    state: { query: '', view: '', filters: { period: '', model: '', status: '' } },
    onChange: vi.fn(),
    userFilter: '',
    onUserChange: vi.fn(),
    simplifiedNames: true,
    onSimplifiedNamesChange: vi.fn(),
    ...overrides,
  };
  render(<ControlPanel {...props} />, { wrapper: TestWrapper });
  return props;
};

describe('ControlPanel', () => {
  it('renders one filter row with a chip per filter and no apply or date inputs', () => {
    renderPanel();
    expect(screen.getByTestId('admin-filter-bar')).toBeInTheDocument();
    for (const id of ['period', 'model', 'user', 'status']) {
      expect(screen.getByTestId(`admin-filter-${id}`)).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: /apply/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /clear all/i })).not.toBeInTheDocument();
    expect(document.querySelector('input[type="datetime-local"]')).toBeNull();
  });

  it('applies a status pick at once through onChange without clearing the chosen user', () => {
    const { onChange, onUserChange } = renderPanel({ userFilter: 'user-1' });
    fireEvent.click(screen.getByTestId('admin-filter-status'));
    fireEvent.click(screen.getByTestId('admin-filter-status-error'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ filters: expect.objectContaining({ status: 'error' }) })
    );
    expect(onUserChange).not.toHaveBeenCalledWith('');
  });

  it('reports the user pick separately and has no user key in the URL', () => {
    expect(MODEL_METRICS_SEARCH_KEYS.filters).not.toHaveProperty('user');
    const { onUserChange } = renderPanel();
    fireEvent.click(screen.getByTestId('admin-filter-user'));
    fireEvent.click(screen.getByTestId('admin-filter-user-user-2'));
    expect(onUserChange).toHaveBeenCalledWith('user-2');
  });

  it('toggles short and full names', () => {
    const { onSimplifiedNamesChange } = renderPanel();
    fireEvent.click(screen.getByTestId('model-metrics-names-full'));
    expect(onSimplifiedNamesChange).toHaveBeenCalledWith(false);
  });
});

import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({ data: vi.fn() }));
vi.mock('@client/app/hooks/data/admin', () => ({
  useAttackSimulationData: mocks.data,
  useRunAttackSimulation: () => ({ mutate: vi.fn(), isPending: false, isError: false, isSuccess: false }),
}));
vi.mock('@client/app/hooks/useSecurityScanCooldown', () => ({
  useSecurityScanCooldown: () => ({ cooldownActive: false, minutesRemaining: 0 }),
}));

import ActiveDefenseTab from './ActiveDefenseTab';

const theme = extendTheme({ ...getThemeConfig() });
const renderTab = () =>
  render(
    <CssVarsProvider theme={theme}>
      <ActiveDefenseTab />
    </CssVarsProvider>
  );

const loaded = {
  runs: [{ runId: 'run-1', status: 'completed', trigger: 'manual', startedAt: '2026-11-02T09:00:00Z' }],
};

describe('ActiveDefenseTab loading', () => {
  beforeEach(() => {
    mocks.data.mockReset();
  });

  it('shows skeleton tables and no findings count instead of the last run line on first load', () => {
    mocks.data.mockReturnValue({ data: undefined, isLoading: true, isFetching: true, error: null, refetch: vi.fn() });
    renderTab();
    expect(screen.getByRole('table', { name: 'Loading findings' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('table', { name: 'Probe run history' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Active findings')).toBeInTheDocument();
    expect(screen.queryByText(/Active findings \(/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Last run:/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('active-defense-updating')).not.toBeInTheDocument();
    expect(screen.getByTestId('active-defense-run-now-btn')).toBeInTheDocument();
  });

  it('shows the updating bar over existing runs while refetching', () => {
    mocks.data.mockReturnValue({ data: loaded, isLoading: false, isFetching: true, error: null, refetch: vi.fn() });
    renderTab();
    expect(screen.getByTestId('active-defense-updating')).toHaveTextContent('Updating');
    expect(screen.getByRole('table', { name: 'Probe run history' })).not.toHaveAttribute('aria-busy');
    expect(screen.getByText(/Last run:/)).toBeInTheDocument();
  });
});

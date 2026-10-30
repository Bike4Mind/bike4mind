import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArenaStats } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import PreferenceArenaTab from './PreferenceArenaTab';

const stats: ArenaStats = {
  pairs: { total: 41, gold: 3, active: 37, activeGold: 2 },
  votes: { total: 1234, credited: 321, creditsAwarded: 4567 },
  raters: { total: 88, qualified: 55, flagged: 2 },
  rejections: { too_fast: 7 },
  winRates: [{ taskType: 'qa', modelId: 'model-one', wins: 3, losses: 1, ties: 0 }],
};

const state = vi.hoisted(() => ({ setActive: vi.fn() }));

vi.mock('@client/app/hooks/data/preferenceArena', () => ({
  useAdminArenaStats: () => ({ data: stats, isPending: false, isError: false, error: null, refetch: vi.fn() }),
  useAdminArenaPairs: () => ({
    data: {
      rows: [
        {
          id: 'pair1',
          prompt: 'Explain tides',
          taskType: 'qa',
          source: 'synthetic',
          active: true,
          isGold: false,
          modelIds: ['model-one', 'model-two'],
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      page: 1,
      limit: 25,
      total: 1,
    },
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useSetArenaPairActive: () => ({ mutate: state.setActive, isPending: false }),
}));
vi.mock('./PreferenceArenaImportBox', () => ({ default: () => <div data-testid="arena-import-card" /> }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const theme = extendTheme({ ...getThemeConfig() });
const renderTab = () =>
  render(
    <CssVarsProvider theme={theme}>
      <PreferenceArenaTab />
    </CssVarsProvider>
  );

describe('PreferenceArenaTab', () => {
  beforeEach(() => {
    state.setActive.mockReset();
  });

  it('renders the totals and a win-rate row', () => {
    renderTab();
    expect(screen.getByText('1,234')).toBeInTheDocument();
    expect(screen.getByText('4,567')).toBeInTheDocument();
    expect(screen.getByText('37 active, 3 gold')).toBeInTheDocument();
    expect(screen.getByText('55 qualified, 2 flagged, 2 active gold')).toBeInTheDocument();
    expect(screen.getByText('Too fast: 7')).toBeInTheDocument();
    const winRates = screen.getByTestId('arena-winrates-table');
    expect(within(winRates).getByText('model-one')).toBeInTheDocument();
    expect(within(winRates).getByText('75.0%')).toBeInTheDocument();
  });

  it('deactivates an active pair through the switch', () => {
    renderTab();
    const toggle = screen.getByTestId('arena-pair-active-pair1');
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(state.setActive).toHaveBeenCalledWith({ id: 'pair1', active: false }, expect.any(Object));
  });
});

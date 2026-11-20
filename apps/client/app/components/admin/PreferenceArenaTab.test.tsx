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

const pair = {
  id: 'pair1',
  prompt: 'Explain tides',
  taskType: 'qa',
  source: 'synthetic',
  active: true,
  isGold: false,
  modelIds: ['model-one', 'model-two'],
  createdAt: '2026-01-01T00:00:00.000Z',
};

const state = vi.hoisted(() => ({
  setActive: vi.fn(),
  stats: undefined as ArenaStats | undefined,
  statsPending: false,
  pairs: [] as (typeof pair)[],
}));

vi.mock('@client/app/hooks/data/preferenceArena', () => ({
  useAdminArenaStats: () => ({
    data: state.stats,
    isPending: state.statsPending,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useAdminArenaPairs: () => ({
    data: { rows: state.pairs, page: 1, limit: 25, total: state.pairs.length },
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
    state.stats = stats;
    state.statsPending = false;
    state.pairs = [pair];
  });

  it('opens with the page header as the first region of the page', () => {
    renderTab();
    const root = screen.getByTestId('preference-arena-tab');
    expect(root.firstElementChild).toBe(screen.getByTestId('admin-page-header'));
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

  it('puts an empty state inside each card when there are no votes or pairs', () => {
    state.stats = { ...stats, rejections: {}, winRates: [] };
    state.pairs = [];
    renderTab();
    const emptyIn = (card: string) => within(screen.getByTestId(card)).getByTestId('admin-empty-state');
    expect(emptyIn('arena-rejections-card')).toHaveTextContent('No rejected votes');
    expect(emptyIn('arena-winrates-card')).toHaveTextContent(
      'No votes yetWin rates appear here once users compare two answers in the arena.'
    );
    expect(emptyIn('arena-pairs-card')).toHaveTextContent('No pairs yetImport pairs below to start the arena.');
  });

  it('shows a loading state, not the empty one, while the totals load', () => {
    state.stats = undefined;
    state.statsPending = true;
    renderTab();
    const rejections = screen.getByTestId('arena-rejections-card');
    expect(within(rejections).getByTestId('arena-rejections-loading')).toHaveTextContent('Loading rejected votes');
    expect(within(rejections).queryByTestId('admin-empty-state')).toBeNull();
  });
});

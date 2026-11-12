import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ILoopsBudget } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  budget: undefined as ILoopsBudget | undefined,
  setBudget: { mutate: vi.fn(), isPending: false },
}));

vi.mock('@client/app/hooks/data/loops', () => ({
  useLoopsBudget: () => ({ data: h.budget }),
  useSetLoopsBudget: () => h.setBudget,
}));

import LoopsBudgetBar from './LoopsBudgetBar';
import { backoffLabel } from './loopUi';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderBar = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <LoopsBudgetBar />
    </CssVarsProvider>
  );

beforeEach(() => vi.clearAllMocks());

describe('LoopsBudgetBar', () => {
  it("shows today's all-loops spend against the effective cap, and saves a new limit", () => {
    h.budget = { creditsToday: 12.4, userDailyCredits: 30, adminDailyCredits: 50, effectiveCap: 30 };
    renderBar();
    expect(screen.getByTestId('loops-budget-today')).toHaveTextContent('Today: 12 / 30 credits across all loops');
    expect(screen.getByTestId('loops-budget-save-btn')).toBeDisabled();

    fireEvent.change(screen.getByTestId('loops-budget-input'), { target: { value: '40' } });
    fireEvent.click(screen.getByTestId('loops-budget-save-btn'));
    expect(h.setBudget.mutate).toHaveBeenCalledWith(40, expect.anything());

    fireEvent.click(screen.getByTestId('loops-budget-clear-btn'));
    expect(h.setBudget.mutate).toHaveBeenLastCalledWith(null, expect.anything());
  });

  it('shows spend alone with no cap, and refuses a non-positive limit', () => {
    h.budget = { creditsToday: 3 };
    renderBar();
    expect(screen.getByTestId('loops-budget-today')).toHaveTextContent('Today: 3 credits across all loops');
    expect(screen.queryByTestId('loops-budget-clear-btn')).toBeNull();
    fireEvent.change(screen.getByTestId('loops-budget-input'), { target: { value: '0' } });
    expect(screen.getByTestId('loops-budget-save-btn')).toBeDisabled();
  });
});

describe('backoffLabel', () => {
  const now = new Date('2026-10-29T12:00:00Z').getTime();
  it('explains a live loop backing off, and is null otherwise', () => {
    const loop = { status: 'live' as const, idleStreak: 3, nextRunAt: new Date(now + 40 * 60_000) };
    expect(backoffLabel(loop, now)).toBe('Backing off: next run in 40 min, nothing changed in the last 3 runs');
    expect(backoffLabel({ ...loop, idleStreak: 0 }, now)).toBeNull();
    expect(backoffLabel({ ...loop, status: 'paused' }, now)).toBeNull();
  });
});

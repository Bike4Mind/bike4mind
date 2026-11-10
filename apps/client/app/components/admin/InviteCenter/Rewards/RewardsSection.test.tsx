import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MIN_PRICE_PER_CREDIT_USD, formatUsdAmount, formatUsdPerCredit } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

let serverSettings: { settingName: string; settingValue: unknown }[] | undefined = [];
const mocks = vi.hoisted(() => ({ mutateAsync: vi.fn(), refetch: vi.fn() }));
vi.mock('@client/app/hooks/data/settings', () => ({
  useSettingsFromServer: () => ({
    data: serverSettings,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: mocks.refetch,
  }),
  useUpdateSettings: () => ({ mutate: vi.fn(), mutateAsync: mocks.mutateAsync, isPending: false, error: null }),
  useFloorAboveMeasuredWarning: () => undefined,
}));
vi.mock('../../ScopedSettingOverrides', () => ({ default: () => null }));
vi.mock('@tanstack/react-router', async () => ({
  ...(await import('../../__tests__/fakeAdminRouter')).fakeRouterModule,
  useBlocker: () => ({ status: 'idle' }),
}));

import { fakeAdminRouter } from '../../__tests__/fakeAdminRouter';
import { REWARD_KEYS } from '../../settingHomes';
import { RewardsSection } from './RewardsSection';

const theme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => <CssVarsProvider theme={theme}>{children}</CssVarsProvider>;
const renderSection = () => render(<RewardsSection />, { wrapper: Wrapper });

beforeEach(() => {
  serverSettings = [];
  mocks.mutateAsync.mockReset().mockResolvedValue(undefined);
  fakeAdminRouter.reset({ tab: 'waitlist', inviteSection: 'rewards' });
});

describe('RewardsSection', () => {
  it('renders an editor for every referral and gear reward key', () => {
    renderSection();
    for (const key of [...REWARD_KEYS.referral, ...REWARD_KEYS.gear]) {
      expect(screen.getByTestId(`admin-setting-${key}-input`), key).toBeTruthy();
      expect(screen.getByTestId(`invite-center-rewards-current-${key}`), key).toBeTruthy();
    }
  });

  it('keeps every inviter reward off by default and values a stored reward in dollars', () => {
    serverSettings = [
      { settingName: 'ReferralFirstPaymentCredits', settingValue: 6000 },
      { settingName: 'ReferralSecondPaymentCredits', settingValue: 0 },
    ];
    renderSection();

    expect(screen.getByTestId('invite-center-rewards-current-ReferralFirstAnswerCredits').textContent).toBe(
      'Current: 0 (default)'
    );
    expect(screen.getByTestId('invite-center-rewards-current-ReferralSecondPaymentCredits').textContent).toBe(
      'Current: 0 - default 0'
    );
    expect(screen.getByTestId('invite-center-rewards-current-ReferralHoldDays').textContent).toBe(
      'Current: 14 (default)'
    );
    const floor = formatUsdPerCredit(MIN_PRICE_PER_CREDIT_USD);
    expect(screen.getByTestId('invite-center-rewards-derived-ReferralFirstPaymentCredits').textContent).toBe(
      `6,000 credits = ${formatUsdAmount(6000 * MIN_PRICE_PER_CREDIT_USD)} at the floor ${floor} per credit`
    );
  });

  it('saves staged edits through the SaveBar', async () => {
    renderSection();
    fireEvent.change(screen.getByTestId('admin-setting-ReferralHoldDays-input'), { target: { value: '21' } });
    fireEvent.change(screen.getByTestId('admin-setting-gearRewardMinAccountAgeDays-input'), {
      target: { value: '0' },
    });
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
    await waitFor(() => expect(screen.queryByTestId('admin-save-bar')).toBeNull());
    expect(mocks.mutateAsync).toHaveBeenCalledWith({ key: 'ReferralHoldDays', value: 21 });
    expect(mocks.mutateAsync).toHaveBeenCalledWith({ key: 'gearRewardMinAccountAgeDays', value: 0 });
  });

  it('opens the Schedule section, where the trickle pool is set', () => {
    renderSection();
    fireEvent.click(screen.getByTestId('invite-center-rewards-open-schedule-btn'));
    expect(fakeAdminRouter.search).toEqual({ tab: 'waitlist', inviteSection: 'schedule' });
  });
});

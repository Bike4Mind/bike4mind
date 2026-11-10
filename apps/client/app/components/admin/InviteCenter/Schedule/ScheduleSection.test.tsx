import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';

let serverSettings: { settingName: string; settingValue: unknown }[] | undefined = [];
const mocks = vi.hoisted(() => ({ mutateAsync: vi.fn(), refetch: vi.fn(), sendLimitsLive: false }));
vi.mock('./scheduleSummary', async importOriginal => ({
  ...(await importOriginal<typeof import('./scheduleSummary')>()),
  get INVITE_SEND_LIMITS_LIVE() {
    return mocks.sendLimitsLive;
  },
}));
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

import { FREE_TIER_LIMIT_KEYS, SIGNUP_SCHEDULE_KEYS } from '../../settingHomes';
import { ScheduleSection } from './ScheduleSection';
import { describeNewAccountGrant, readScheduleValues } from './scheduleSummary';

const theme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => <CssVarsProvider theme={theme}>{children}</CssVarsProvider>;
const renderSection = () => render(<ScheduleSection />, { wrapper: Wrapper });
const seed = (rows: Record<string, unknown>) => {
  serverSettings = Object.entries(rows).map(([settingName, settingValue]) => ({ settingName, settingValue }));
};

beforeEach(() => {
  serverSettings = [];
  mocks.mutateAsync.mockReset().mockResolvedValue(undefined);
  mocks.sendLimitsLive = false;
});

describe('ScheduleSection', () => {
  it('renders an editor for every schedule and free-tier limit key', () => {
    renderSection();
    for (const key of [...SIGNUP_SCHEDULE_KEYS, ...FREE_TIER_LIMIT_KEYS]) {
      expect(screen.getByTestId(`admin-setting-${key}-input`), key).toBeTruthy();
      expect(screen.getByTestId(`invite-center-schedule-current-${key}`), key).toBeTruthy();
    }
  });

  it('summarizes the saved schedule', () => {
    const rows = {
      signupGrantInitialCredits: 1000,
      signupGrantDailyCredits: 100,
      signupGrantDripCap: 5000,
      signupGrantSignupPoolDaily: 50000,
      signupGrantTricklePoolDaily: 20000,
    };
    seed(rows);
    renderSection();
    expect(screen.getByTestId('invite-center-schedule-summary').textContent).toBe(
      describeNewAccountGrant(readScheduleValues(new Map(Object.entries(rows))))
    );
    expect(screen.queryByTestId('invite-center-schedule-drip-warning')).toBeNull();
    expect(screen.queryByTestId('invite-center-schedule-invite-bonus-warning')).toBeNull();
  });

  it('warns when the drip cap is below the daily credits', () => {
    seed({ signupGrantDailyCredits: 100, signupGrantDripCap: 50 });
    renderSection();
    expect(screen.getByTestId('invite-center-schedule-drip-warning').textContent).toContain('(50)');
  });

  it('warns when an invite bonus is set', () => {
    seed({ signupGrantInviteBonusCredits: 500 });
    renderSection();
    expect(screen.getByTestId('invite-center-schedule-invite-bonus-warning')).toBeTruthy();
  });

  it('drops the invite bonus warning once send limits are live', () => {
    mocks.sendLimitsLive = true;
    seed({ signupGrantInviteBonusCredits: 500 });
    renderSection();
    expect(screen.queryByTestId('invite-center-schedule-invite-bonus-warning')).toBeNull();
  });

  it('keeps the summary on saved values while an edit is staged', () => {
    const rows = { signupGrantDailyCredits: 100, signupGrantDripCap: 500 };
    seed(rows);
    renderSection();
    const saved = describeNewAccountGrant(readScheduleValues(new Map(Object.entries(rows))));
    expect(screen.getByTestId('invite-center-schedule-summary').textContent).toBe(saved);
    fireEvent.change(screen.getByTestId('admin-setting-signupGrantDripCap-input'), { target: { value: '50' } });
    expect(screen.getByTestId('invite-center-schedule-summary').textContent).toBe(saved);
    expect(screen.queryByTestId('invite-center-schedule-drip-warning')).toBeNull();
  });

  it('saves staged edits through the SaveBar', async () => {
    renderSection();
    fireEvent.change(screen.getByTestId('admin-setting-signupGrantDripCap-input'), { target: { value: '4000' } });
    fireEvent.change(screen.getByTestId('admin-setting-freeTierDay1SpendCapCredits-input'), {
      target: { value: '75' },
    });
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
    await waitFor(() => expect(screen.queryByTestId('admin-save-bar')).toBeNull());
    expect(mocks.mutateAsync).toHaveBeenCalledWith({ key: 'signupGrantDripCap', value: 4000 });
    expect(mocks.mutateAsync).toHaveBeenCalledWith({ key: 'freeTierDay1SpendCapCredits', value: 75 });
  });
});

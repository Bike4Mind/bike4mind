import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { SignupGrant } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  grant: undefined as SignupGrant | undefined,
  held: undefined as 'budget_exhausted' | undefined,
  activity: true as boolean | string | undefined,
  daily: 1000 as number | string | undefined,
  minSeconds: undefined as number | undefined,
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { signupGrant: h.grant, signupGrantHeldReason: h.held } }),
}));
vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: (key: string) =>
    key === 'signupGrantActivityDailyCredits'
      ? h.daily
      : key === 'signupGrantActivityMinActiveSeconds'
        ? h.minSeconds
        : h.activity,
}));
import SignupGrantStatus from './SignupGrantStatus';
const theme = extendTheme({ ...getThemeConfig() });
const show = () =>
  render(
    <CssVarsProvider theme={theme}>
      <SignupGrantStatus />
    </CssVarsProvider>
  );

describe('signup grant status', () => {
  beforeEach(() => {
    h.activity = true;
    h.daily = 1000;
    h.held = undefined;
    h.minSeconds = undefined;
    h.grant = {
      stage: 'signup',
      signupCredits: 1000,
      unlockCredits: 9000,
      creditsReleased: 1000,
      nextCondition: 'verification',
    };
  });
  it('does not advertise a grant to existing accounts', () => {
    h.grant = undefined;
    show();
    expect(screen.queryByTestId('signup-grant-status')).toBeNull();
  });
  it('shows the locked amount and names every unlock path with its amount', () => {
    show();
    expect(screen.getByTestId('signup-grant-released')).toHaveTextContent('9,000 more credits are still locked');
    const paths = screen.getByTestId('signup-grant-unlock-paths');
    expect(paths).toHaveTextContent(
      'up to 1,000 credits for each day you have Bike4Mind open and in use for about 1 minute'
    );
    expect(paths).toHaveTextContent('when you subscribe');
    expect(paths).toHaveTextContent('when you verify a card');
    expect(screen.getByTestId('signup-grant-status')).not.toHaveTextContent('eligibility');
  });
  it('derives the minutes from the setting', () => {
    h.minSeconds = 1800;
    show();
    expect(screen.getByTestId('signup-grant-unlock-paths')).toHaveTextContent('for about 30 minutes');
  });
  it('omits the daily drip when the unlock pool is 0', () => {
    h.grant = { ...h.grant!, unlockCredits: 0 };
    show();
    expect(screen.queryByTestId('signup-grant-unlock-paths')).toBeNull();
  });
  it('shows the unlock date of a bonus held for a settling payment instead of the unlock paths', () => {
    const releaseAt = new Date('2026-11-02T08:45:00.000Z');
    h.grant = { ...h.grant!, heldUnlock: { reason: 'subscription', heldAt: new Date(), releaseAt } };
    show();
    const held = screen.getByTestId('signup-grant-held-unlock');
    expect(held).toHaveTextContent(
      `They unlock on ${releaseAt.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
    );
    expect(screen.queryByTestId('signup-grant-unlock-paths')).toBeNull();
  });
  it('has no eligibility-check button', () => {
    show();
    expect(screen.queryByRole('button')).toBeNull();
  });
  it.each([
    [false, 1000],
    ['false', 1000],
    [true, 0],
    [true, undefined],
  ])('omits the daily drip when activity=%j and daily=%j', (activity, daily) => {
    h.activity = activity;
    h.daily = daily;
    show();
    const paths = screen.getByTestId('signup-grant-unlock-paths');
    expect(paths).not.toHaveTextContent('each day');
    expect(paths).toHaveTextContent('when you subscribe');
  });
  it('drops the unlock paths once the grant is fully released', () => {
    h.grant = { ...h.grant!, creditsReleased: 10000, stage: 'unlocked', nextCondition: null };
    show();
    expect(screen.getByTestId('signup-grant-released')).toHaveTextContent('fully released');
    expect(screen.queryByTestId('signup-grant-unlock-paths')).toBeNull();
  });
  it('asks a pending account to verify its email', () => {
    h.grant = { ...h.grant!, stage: 'pending_email', creditsReleased: 0, nextCondition: 'email_verification' };
    show();
    expect(screen.getByTestId('signup-grant-released')).toHaveTextContent('Verify your email');
  });

  it('says free credits are being prepared while the daily budget holds the tranche', () => {
    h.held = 'budget_exhausted';
    h.grant = { ...h.grant!, stage: 'pending_email', creditsReleased: 0, nextCondition: 'email_verification' };
    show();
    expect(screen.getByTestId('signup-grant-status').textContent).toBe('Your free credits are being prepared.');
  });

  it('shows the held message for a flat-grant account with no staged grant', () => {
    h.held = 'budget_exhausted';
    h.grant = undefined;
    show();
    expect(screen.getByText('Your free credits are being prepared.')).toBeTruthy();
  });

  it('ignores a held flag once the tranche has been released', () => {
    h.held = 'budget_exhausted';
    show();
    expect(screen.queryByText('Your free credits are being prepared.')).toBeNull();
  });
});

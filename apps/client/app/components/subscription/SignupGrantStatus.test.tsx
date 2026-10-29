import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { SignupGrant } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  grant: undefined as SignupGrant | undefined,
  held: undefined as 'budget_exhausted' | undefined,
  enabled: true as boolean | string | undefined,
  organizationInvites: false as boolean | string | undefined,
  post: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { signupGrant: h.grant, signupGrantHeldReason: h.held }, refreshUser: h.refresh }),
}));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: h.post } }));
vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: (key: string) => (key === 'signupGrantOrgInviteEnabled' ? h.organizationInvites : h.enabled),
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
    vi.clearAllMocks();
    h.enabled = true;
    h.held = undefined;
    h.organizationInvites = false;
    h.grant = {
      stage: 'signup',
      signupCredits: 12,
      unlockCredits: 28,
      creditsReleased: 12,
      nextCondition: 'verification',
    };
    h.post.mockResolvedValue({ data: { creditsGranted: 28 } });
    h.refresh.mockResolvedValue(undefined);
  });
  it('does not enroll or advertise a grant to existing accounts', () => {
    h.grant = undefined;
    show();
    expect(screen.queryByTestId('signup-grant-status')).toBeNull();
  });
  it('shows account-specific remaining credits and refreshes after a successful check', async () => {
    show();
    expect(screen.getByTestId('signup-grant-status')).toHaveTextContent('28 more credits');
    fireEvent.click(screen.getByTestId('signup-grant-check-btn'));
    await waitFor(() => expect(screen.getByTestId('signup-grant-result')).toHaveTextContent('28 credits unlocked'));
    expect(h.post).toHaveBeenCalledWith('/api/users/signup-grant-eligibility');
    expect(h.refresh).toHaveBeenCalled();
  });
  it('still reports a committed unlock when the follow-up refresh fails', async () => {
    h.refresh.mockRejectedValue(new Error('network'));
    show();
    fireEvent.click(screen.getByTestId('signup-grant-check-btn'));
    await waitFor(() => expect(screen.getByTestId('signup-grant-result')).toHaveTextContent('28 credits unlocked'));
  });
  it('keeps accepted organization invites retryable when activity is disabled', () => {
    h.enabled = false;
    h.organizationInvites = true;
    show();
    expect(screen.getByTestId('signup-grant-check-btn')).toHaveTextContent('Check grant eligibility');
  });
  it.each([false, 'false'])('does not advertise disabled activity with %s', async enabled => {
    h.enabled = enabled;
    h.organizationInvites = true;
    h.post.mockResolvedValue({ data: { creditsGranted: 0 } });
    show();
    fireEvent.click(screen.getByTestId('signup-grant-check-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('signup-grant-result')).toHaveTextContent('accepted organization invite')
    );
    expect(screen.getByTestId('signup-grant-result')).not.toHaveTextContent('chat on different days');
  });
  it('accepts persisted string booleans', () => {
    h.enabled = 'true';
    const view = show();
    expect(screen.getByTestId('signup-grant-check-btn')).toBeInTheDocument();
    view.unmount();
    h.enabled = 'false';
    show();
    expect(screen.queryByTestId('signup-grant-check-btn')).toBeNull();
  });
  it.each([
    [undefined, undefined],
    [false, false],
    ['false', 'false'],
    ['', 'TRUE'],
  ])('hides eligibility checks when neither source is enabled (%j, %j)', (activity, organizationInvites) => {
    h.enabled = activity;
    h.organizationInvites = organizationInvites;
    show();
    expect(screen.queryByTestId('signup-grant-check-btn')).toBeNull();
  });
  it.each([true, 'true'])('does not advertise disabled organization unlocks when activity is %j', async activity => {
    h.enabled = activity;
    h.organizationInvites = 'false';
    h.post.mockResolvedValue({ data: { creditsGranted: 0 } });
    show();
    fireEvent.click(screen.getByTestId('signup-grant-check-btn'));
    await waitFor(() => expect(screen.getByTestId('signup-grant-result')).toHaveTextContent('chat on different days'));
    expect(screen.getByTestId('signup-grant-result')).not.toHaveTextContent('organization invite');
  });
  it.each([true, 'true'])('shows both enabled sources when organization unlocks are %j', async organizationInvites => {
    h.organizationInvites = organizationInvites;
    h.post.mockResolvedValue({ data: { creditsGranted: 0 } });
    show();
    fireEvent.click(screen.getByTestId('signup-grant-check-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('signup-grant-result')).toHaveTextContent(
        'Accept an organization invite or keep using chat'
      )
    );
  });
  it('explains ineligibility without claiming credits were granted', async () => {
    h.post.mockResolvedValue({ data: { creditsGranted: 0 } });
    show();
    fireEvent.click(screen.getByTestId('signup-grant-check-btn'));
    await waitFor(() => expect(screen.getByTestId('signup-grant-result')).toHaveTextContent('Not eligible yet'));
  });
  it('leaves failures retryable', async () => {
    h.post.mockRejectedValue(new Error('unavailable'));
    show();
    fireEvent.click(screen.getByTestId('signup-grant-check-btn'));
    await waitFor(() => expect(screen.getByTestId('signup-grant-result')).toHaveTextContent('try again later'));
    expect(screen.getByTestId('signup-grant-check-btn')).not.toBeDisabled();
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

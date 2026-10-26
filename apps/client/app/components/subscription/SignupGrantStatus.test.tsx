import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { SignupGrant } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  grant: undefined as SignupGrant | undefined,
  enabled: true as boolean | string,
  post: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { signupGrant: h.grant }, refreshUser: h.refresh }),
}));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: h.post } }));
vi.mock('@client/app/hooks/data/settings', () => ({ useGetSettingsValue: () => h.enabled }));
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
    expect(h.post).toHaveBeenCalledWith('/api/users/signup-grant-activity');
    expect(h.refresh).toHaveBeenCalled();
  });
  it('does not promise an unavailable activity flow', () => {
    h.enabled = false;
    show();
    expect(screen.queryByTestId('signup-grant-check-btn')).toBeNull();
  });
  it('accepts persisted string booleans without treating false as enabled', () => {
    h.enabled = 'true';
    const view = show();
    expect(screen.getByTestId('signup-grant-check-btn')).toBeInTheDocument();
    view.unmount();
    h.enabled = 'false';
    show();
    expect(screen.queryByTestId('signup-grant-check-btn')).toBeNull();
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
});

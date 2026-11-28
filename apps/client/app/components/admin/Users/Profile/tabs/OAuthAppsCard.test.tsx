import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProfileTestWrapper } from '../profileTestUtils';

const mocks = vi.hoisted(() => ({ useApps: vi.fn() }));
vi.mock('@client/app/hooks/data/adminUserOAuthApps', () => ({ useAdminUserOAuthApps: mocks.useApps }));

import { OAuthAppsCard } from './OAuthAppsCard';

const renderCard = () => render(<OAuthAppsCard userId="u1" />, { wrapper: ProfileTestWrapper });

beforeEach(() => mocks.useApps.mockReset());

describe('OAuthAppsCard', () => {
  it('lists each app with its first and last sign-in, in the order given', () => {
    mocks.useApps.mockReturnValue({
      data: {
        signupClient: null,
        apps: [
          {
            clientId: 'b4m_beta_22222222',
            name: 'Beta',
            firstSignInAt: '2026-11-01T10:00:00.000Z',
            lastSignInAt: '2026-11-20T10:00:00.000Z',
          },
          {
            clientId: 'b4m_gone_33333333',
            name: null,
            firstSignInAt: '2026-10-02T10:00:00.000Z',
            lastSignInAt: '2026-10-03T10:00:00.000Z',
          },
        ],
      },
    });
    renderCard();
    const beta = screen.getByTestId('user-profile-oauth-app-b4m_beta_22222222');
    const card = screen.getByTestId('user-profile-oauth-apps-card');
    expect(card).toHaveTextContent('Beta');
    expect(beta).toHaveTextContent('Last sign-in');
    expect(beta).toHaveTextContent('First');
    expect(card).toHaveTextContent('b4m_gone_33333333');
    expect(screen.queryByTestId('user-profile-oauth-apps-empty')).not.toBeInTheDocument();
  });

  it('says so when there are no sign-ins', () => {
    mocks.useApps.mockReturnValue({ data: { signupClient: null, apps: [] } });
    renderCard();
    expect(screen.getByTestId('user-profile-oauth-apps-empty')).toHaveTextContent(
      'No sign-ins through other apps recorded'
    );
  });

  it('does not claim the list is empty while loading or after a failure', () => {
    mocks.useApps.mockReturnValue({ isLoading: true });
    const { unmount } = renderCard();
    expect(screen.queryByTestId('user-profile-oauth-apps-empty')).not.toBeInTheDocument();
    unmount();
    mocks.useApps.mockReturnValue({ isError: true, refetch: vi.fn() });
    renderCard();
    expect(screen.getByTestId('user-profile-oauth-apps-retry-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('user-profile-oauth-apps-empty')).not.toBeInTheDocument();
  });

  it('keeps the list and offers no reload when a refetch fails but data is present', () => {
    mocks.useApps.mockReturnValue({
      isError: true,
      refetch: vi.fn(),
      data: {
        signupClient: null,
        apps: [
          {
            clientId: 'b4m_beta_22222222',
            name: 'Beta',
            firstSignInAt: '2026-11-01T10:00:00.000Z',
            lastSignInAt: '2026-11-20T10:00:00.000Z',
          },
        ],
      },
    });
    renderCard();
    expect(screen.getByTestId('user-profile-oauth-app-b4m_beta_22222222')).toBeInTheDocument();
    expect(screen.queryByTestId('user-profile-oauth-apps-retry-btn')).not.toBeInTheDocument();
  });
});

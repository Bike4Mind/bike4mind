import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { securityPaletteDark, securityPaletteLight } from '@client/app/theme/securityTheme';
import SecurityTab, { SECURITY_TAB_QUERY_KEYS } from './index';

const h = vi.hoisted(() => ({
  user: { id: 'u1', isAdmin: true } as { id: string; isAdmin: boolean } | null,
  events: { data: undefined, isLoading: false } as { data?: { items: unknown[]; since: string }; isLoading: boolean },
}));

vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: h.user }) }));
vi.mock('@client/app/hooks/data/admin', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/hooks/data/admin')>()),
  useGetAllRecentSecurityEvents: () => h.events,
}));
vi.mock('@client/app/components/help', () => ({ ContextHelpButton: () => null }));
vi.mock('@client/app/components/ProfileModal/SettingsTabContent/MfaCard', () => ({
  default: () => <div data-testid="mfa-card-stub" />,
}));
vi.mock('@client/app/components/ProfileModal/SettingsTabContent/ActiveSessionsSection', () => ({
  default: () => <div data-testid="active-sessions-stub" />,
}));
vi.mock('@client/app/components/ProfileModal/SettingsTabContent/ApprovedAppsSection', () => ({
  default: () => <div data-testid="approved-apps-stub" />,
}));
vi.mock('./SupportAccessActivity', async importOriginal => ({
  ...(await importOriginal<typeof import('./SupportAccessActivity')>()),
  SupportAccessActivity: () => <div data-testid="support-access-stub" />,
}));
vi.mock('./ApiKeyUsageSection', () => ({ default: () => <div data-testid="api-key-usage-stub" /> }));
vi.mock('./BlockedIPsSection', () => ({ default: () => <div data-testid="blocked-ips-stub" /> }));

// The sections read both the app tokens (getThemeConfig) and theme.palette.security.*, which
// getThemeConfig does not carry.
const base = getThemeConfig();
const theme = extendTheme({
  ...base,
  colorSchemes: {
    light: { palette: { ...base.colorSchemes?.light?.palette, ...securityPaletteLight } },
    dark: { palette: { ...base.colorSchemes?.dark?.palette, ...securityPaletteDark } },
  },
});

const renderTab = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
    </QueryClientProvider>
  );
  return { ...render(<SecurityTab />, { wrapper: Wrapper }), invalidate };
};

const SHARED_SECTIONS = [
  ['security-mfa-section', 'mfa-card-stub'],
  ['security-sessions-section', 'active-sessions-stub'],
  ['security-signin-activity-section', 'security-signin-activity-count'],
  ['security-support-access-section', 'support-access-stub'],
  ['security-approved-apps-section', 'approved-apps-stub'],
  ['security-api-keys-section', 'api-key-usage-stub'],
] as const;

describe('SecurityTab', () => {
  beforeEach(() => {
    h.user = { id: 'u1', isAdmin: true };
    h.events = { data: { items: [], since: '2026-10-27T00:00:00Z' }, isLoading: false };
  });

  it('renders the header and every section for an admin', () => {
    renderTab();

    expect(screen.getByRole('heading', { name: 'Security' })).toBeInTheDocument();
    for (const [section, content] of SHARED_SECTIONS) {
      expect(within(screen.getByTestId(section)).getByTestId(content)).toBeInTheDocument();
    }
    expect(
      within(screen.getByTestId('security-blocked-ips-section')).getByTestId('blocked-ips-stub')
    ).toBeInTheDocument();
  });

  it('hides the system-wide blocked IP list from a non-admin and keeps the rest', () => {
    h.user = { id: 'u2', isAdmin: false };
    renderTab();

    for (const [section] of SHARED_SECTIONS) {
      expect(screen.getByTestId(section)).toBeInTheDocument();
    }
    expect(screen.queryByTestId('security-blocked-ips-section')).not.toBeInTheDocument();
    expect(screen.queryByTestId('blocked-ips-stub')).not.toBeInTheDocument();
  });

  it('is a single page with no sub-tab bar', () => {
    renderTab();

    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('shows the sign-in empty state when the last 7 days have no attempts', () => {
    renderTab();

    const section = screen.getByTestId('security-signin-activity-section');
    expect(section).toHaveTextContent('No failed sign-ins or suspicious attempts in the last 7 days');
    expect(within(section).getByTestId('security-signin-activity-count')).toHaveTextContent('0');
    expect(screen.queryByTestId('security-signin-activity-list')).not.toBeInTheDocument();
  });

  it('shows a spinner while the sign-in attempts load', () => {
    h.events = { data: undefined, isLoading: true };
    renderTab();

    expect(within(screen.getByTestId('security-signin-activity-section')).getByRole('progressbar')).toBeInTheDocument();
  });

  it('renders one row per sign-in attempt', () => {
    h.events = {
      data: {
        since: '2026-10-27T00:00:00Z',
        items: [
          {
            type: 'failed_login',
            timestamp: '2026-11-01T10:00:00Z',
            data: { username: 'me@example.com', ip: '198.51.100.4', reason: 'Invalid password' },
          },
          {
            type: 'suspicious_pattern',
            timestamp: '2026-11-02T10:00:00Z',
            data: {
              ip: '203.0.113.9',
              attempts: 7,
              usernames: [],
              riskLevel: 'high',
              lastAttempt: '',
              firstAttempt: '',
            },
          },
        ],
      },
      isLoading: false,
    };
    renderTab();

    const list = screen.getByTestId('security-signin-activity-list');
    expect(list.children).toHaveLength(2);
    expect(screen.getByTestId('security-signin-activity-count')).toHaveTextContent('2');
    expect(within(list).getByTestId('security-signin-activity-failed_login-0')).toHaveTextContent('198.51.100.4');
    expect(within(list).getByTestId('security-signin-activity-suspicious_pattern-1')).toHaveTextContent('7 attempts');
    expect(screen.queryByText('No failed sign-ins or suspicious attempts in the last 7 days')).not.toBeInTheDocument();
  });

  it('refreshes every query the page reads', async () => {
    const { invalidate } = renderTab();

    fireEvent.click(screen.getByTestId('security-summary-refresh-btn'));

    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(SECURITY_TAB_QUERY_KEYS.length));
    for (const queryKey of SECURITY_TAB_QUERY_KEYS) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey });
    }
  });
});

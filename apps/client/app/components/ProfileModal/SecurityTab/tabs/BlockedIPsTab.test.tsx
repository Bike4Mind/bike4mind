import type { ReactNode } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMANENT_IP_BLOCK_EXPIRES_AT } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { securityPaletteDark, securityPaletteLight } from '@client/app/theme/securityTheme';
import BlockedIPsTab from './BlockedIPsTab';

const h = vi.hoisted(() => ({ items: [] as Record<string, unknown>[] }));

vi.mock('@client/app/hooks/data/admin', () => ({
  useGetBlockedIPs: () => ({ data: h.items, isLoading: false }),
  useBlockIP: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUnblockIP: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// The tab reads both the admin tokens (getThemeConfig) and theme.palette.security.*, which
// getThemeConfig does not carry.
const base = getThemeConfig();
const theme = extendTheme({
  ...base,
  colorSchemes: {
    light: { palette: { ...base.colorSchemes?.light?.palette, ...securityPaletteLight } },
    dark: { palette: { ...base.colorSchemes?.dark?.palette, ...securityPaletteDark } },
  },
});
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
);

const renderTab = () => render(<BlockedIPsTab />, { wrapper: TestWrapper });

describe('BlockedIPsTab', () => {
  beforeEach(() => {
    h.items = [];
  });

  it('shows an empty state', () => {
    renderTab();
    expect(screen.getByTestId('blocked-ips-tab-count')).toHaveTextContent('0 blocked');
    expect(screen.queryByTestId('blocked-ips-tab-list')).not.toBeInTheDocument();
  });

  it('shows the scope, expiry, reason and who blocked each entry', () => {
    h.items = [
      {
        _id: 'b1',
        ip: '203.0.113.0/24',
        scope: 'all',
        reason: 'Card testing or payment fraud',
        source: 'manual',
        blockedByName: 'admin@example.com',
        blockedAt: '2026-10-01T00:00:00Z',
        expiresAt: PERMANENT_IP_BLOCK_EXPIRES_AT.toISOString(),
      },
      {
        _id: 'b2',
        ip: '198.51.100.4',
        reason: 'Too many failed login attempts',
        source: 'auto',
        blockedAt: '2026-10-01T00:00:00Z',
        expiresAt: '2026-10-02T09:12:00Z',
      },
    ];
    renderTab();

    expect(screen.getByTestId('blocked-ips-tab-count')).toHaveTextContent('2 blocked');
    const manual = screen.getByTestId('blocked-ip-0');
    expect(within(manual).getByTestId('blocked-ip-0-scope')).toHaveTextContent('Sign-in, signup, checkout and AI');
    expect(within(manual).getByTestId('blocked-ip-0-expiry')).toHaveTextContent('Never');
    expect(within(manual).getByTestId('blocked-ip-0-by')).toHaveTextContent('admin@example.com');
    expect(manual).toHaveTextContent('Card testing or payment fraud');

    const lockout = screen.getByTestId('blocked-ip-1');
    expect(within(lockout).getByTestId('blocked-ip-1-scope')).toHaveTextContent('Sign-in only');
    expect(within(lockout).getByTestId('blocked-ip-1-expiry')).toHaveTextContent('2 Oct 2026, 09:12 UTC');
    expect(within(lockout).getByTestId('blocked-ip-1-by')).toHaveTextContent('Automatic');
  });

  it('opens the block and unblock dialogs', () => {
    h.items = [{ _id: 'b1', ip: '203.0.113.9', scope: 'all', blockedAt: '2026-10-01', expiresAt: '2026-10-02' }];
    renderTab();

    fireEvent.click(screen.getByTestId('blocked-ips-tab-block-btn'));
    expect(screen.getByTestId('block-ip-dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('block-ip-dialog-cancel-btn'));

    fireEvent.click(screen.getByTestId('blocked-ip-0-unblock-btn'));
    expect(screen.getByTestId('unblock-ip-dialog')).toHaveTextContent('Unblock 203.0.113.9?');
  });
});

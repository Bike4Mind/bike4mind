import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import AppTheme from '@client/app/utils/themes/AppTheme';
import { AdminTurnstileStatusNotice } from './AdminTurnstileStatusNotice';

const mockUseConfig = vi.hoisted(() => vi.fn());
vi.mock('@client/app/hooks/data/settings', () => ({ useConfig: () => mockUseConfig() }));

const renderNotice = (enabled: boolean, data: { turnstileSecretConfigured: boolean } | undefined) => {
  mockUseConfig.mockReturnValue({ data });
  render(
    <AppTheme>
      <AdminTurnstileStatusNotice enabled={enabled} />
    </AppTheme>
  );
};

const ALERT = 'admin-turnstile-secret-missing-alert';

describe('AdminTurnstileStatusNotice', () => {
  it('warns when Turnstile is on and no secret is provisioned', () => {
    renderNotice(true, { turnstileSecretConfigured: false });
    expect(screen.getByTestId(ALERT).textContent).toContain('TURNSTILE_SECRET_KEY');
  });

  it('stays hidden when Turnstile is off', () => {
    renderNotice(false, { turnstileSecretConfigured: false });
    expect(screen.queryByTestId(ALERT)).toBeNull();
  });

  it('stays hidden when the secret is provisioned', () => {
    renderNotice(true, { turnstileSecretConfigured: true });
    expect(screen.queryByTestId(ALERT)).toBeNull();
  });

  it('stays hidden while the server config is still loading', () => {
    renderNotice(true, undefined);
    expect(screen.queryByTestId(ALERT)).toBeNull();
  });
});

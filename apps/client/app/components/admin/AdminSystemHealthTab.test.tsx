import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: mocks.get, post: mocks.post, put: mocks.put },
}));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import AdminSystemHealthTab from './AdminSystemHealthTab';

const appTheme = extendTheme({ ...getThemeConfig() });

const HEALTH_URL = '/api/admin/system-health';
const INTEGRATIONS_URL = '/api/admin/system-health/integration-health';

const HEALTH = {
  email: {
    configured: false,
    secrets: { MAIL_HOST: true, MAIL_PASSWORD: false },
    missingSecrets: ['MAIL_PASSWORD'],
    optionalSecrets: [],
  },
  database: { type: 'MongoDB', connected: true, readyState: 1 },
  oauth: {
    google: { configured: true, missingSecrets: [] },
    github: { configured: true, missingSecrets: [] },
    okta: { configured: false, missingSecrets: ['OKTA_CLIENT_ID'], effectiveSource: 'none' },
  },
};

const INTEGRATIONS = {
  integrations: [
    {
      integration: 'slack',
      status: 'healthy',
      latencyMs: 120,
      lastCheckedAt: '2026-11-13T10:00:00.000Z',
      successRate: 0.99,
      consecutiveFailures: 0,
      error: null,
      circuitBreaker: { available: true, reason: null, mode: 'auto', autoTripped: false },
    },
    {
      integration: 'github',
      status: 'unhealthy',
      latencyMs: 0,
      lastCheckedAt: '2026-11-13T10:00:00.000Z',
      successRate: 0.4,
      consecutiveFailures: 5,
      error: 'HTTP 502',
      circuitBreaker: { available: false, reason: 'tripped', mode: 'auto', autoTripped: true },
    },
    {
      integration: 'jira',
      status: 'unhealthy',
      latencyMs: 0,
      lastCheckedAt: '2026-11-13T10:00:00.000Z',
      successRate: 0,
      consecutiveFailures: 0,
      error: null,
      circuitBreaker: { available: false, reason: 'manual', mode: 'force_block', autoTripped: false },
    },
  ],
};

const respond = (overrides: Record<string, () => Promise<unknown>> = {}) =>
  mocks.get.mockImplementation((url: string) => {
    const override = overrides[url];
    if (override) return override();
    if (url === HEALTH_URL) return Promise.resolve({ data: HEALTH });
    if (url === INTEGRATIONS_URL) return Promise.resolve({ data: INTEGRATIONS });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });

const renderTab = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CssVarsProvider theme={appTheme}>
        <AdminSystemHealthTab />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

describe('AdminSystemHealthTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    respond();
    mocks.post.mockResolvedValue({ data: { success: true, sentTo: 'admin@example.com', timestamp: '2026-11-13' } });
  });

  it('renders one page header with the h1', async () => {
    renderTab();

    const header = await screen.findByTestId('admin-page-header');
    expect(within(header).getByRole('heading', { level: 1, name: 'System health' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(within(header).getByTestId('system-health-refresh-btn')).toBeInTheDocument();
  });

  it('shows missing configuration as a warning, not an error', async () => {
    renderTab();

    const email = await screen.findByTestId('system-health-email-status');
    expect(email).toHaveAttribute('data-tone', 'warn');
    expect(email).toHaveTextContent('Missing');
    const okta = screen.getByTestId('system-health-oauth-okta-status');
    expect(okta).toHaveAttribute('data-tone', 'warn');
    expect(okta).toHaveTextContent('Missing');
    expect(screen.getByTestId('system-health-oauth-google-status')).toHaveAttribute('data-tone', 'good');
  });

  it('lists only the sender secret on SES and names it in the hint', async () => {
    const sesEmail = {
      configured: false,
      transport: 'ses',
      secrets: { MAIL_FROM: false },
      missingSecrets: ['MAIL_FROM'],
      optionalSecrets: [],
    };
    respond({ [HEALTH_URL]: () => Promise.resolve({ data: { ...HEALTH, email: sesEmail } }) });
    renderTab();

    const sender = await screen.findByTestId('system-health-email-secret-MAIL_FROM');
    expect(sender).toHaveTextContent('Sender address');
    expect(sender).toHaveTextContent('MAIL_FROM: the address system emails are sent from');
    expect(screen.getByTestId('system-health-email-delivery')).toHaveTextContent('Sent through Amazon SES');
    expect(screen.queryByTestId('system-health-email-secret-MAIL_HOST')).not.toBeInTheDocument();
    expect(screen.getByTestId('system-health-email-secret-hint-MAIL_FROM')).toHaveTextContent(
      'sst secret set MAIL_FROM'
    );
    expect(screen.queryByTestId('system-health-email-secret-hint-MAIL_HOST')).not.toBeInTheDocument();
  });

  it.each([
    ['setting', 'Set in admin settings (mailFrom)'],
    ['secret', 'From the MAIL_FROM secret'],
  ])('says the sender comes from the %s without printing it', async (senderSource, label) => {
    const sesEmail = {
      configured: true,
      transport: 'ses',
      secrets: { MAIL_FROM: true },
      missingSecrets: [],
      optionalSecrets: [],
      senderSource,
    };
    respond({ [HEALTH_URL]: () => Promise.resolve({ data: { ...HEALTH, email: sesEmail } }) });
    renderTab();

    const sender = await screen.findByTestId('system-health-email-secret-MAIL_FROM');
    expect(within(sender).getByTestId('system-health-email-sender-source')).toHaveTextContent(label);
    expect(sender).not.toHaveTextContent('@');
  });

  it('names no sender source when no sender is set', async () => {
    const sesEmail = {
      configured: false,
      transport: 'ses',
      secrets: { MAIL_FROM: false },
      missingSecrets: ['MAIL_FROM'],
      optionalSecrets: [],
    };
    respond({ [HEALTH_URL]: () => Promise.resolve({ data: { ...HEALTH, email: sesEmail } }) });
    renderTab();

    await screen.findByTestId('system-health-email-secret-MAIL_FROM');
    expect(screen.queryByTestId('system-health-email-sender-source')).not.toBeInTheDocument();
  });

  it('gives a set command for every missing SMTP secret', async () => {
    const smtpEmail = {
      configured: false,
      transport: 'smtp',
      secrets: { MAIL_HOST: false, MAIL_PORT: false, MAIL_USERNAME: true, MAIL_PASSWORD: false, MAIL_FROM: true },
      missingSecrets: ['MAIL_HOST', 'MAIL_PORT', 'MAIL_PASSWORD'],
      optionalSecrets: [],
    };
    respond({ [HEALTH_URL]: () => Promise.resolve({ data: { ...HEALTH, email: smtpEmail } }) });
    renderTab();

    for (const name of smtpEmail.missingSecrets) {
      expect(await screen.findByTestId(`system-health-email-secret-hint-${name}`)).toHaveTextContent(
        `sst secret set ${name}`
      );
    }
    expect(screen.queryByTestId('system-health-email-secret-hint-MAIL_FROM')).not.toBeInTheDocument();
  });

  it('points a self-host deploy at the env file and chart instead of sst secret set', async () => {
    respond({ [HEALTH_URL]: () => Promise.resolve({ data: { ...HEALTH, selfHost: true } }) });
    renderTab();

    const hint = await screen.findByTestId('system-health-email-hint');
    expect(hint).toHaveTextContent('.env.selfhost');
    expect(hint).toHaveTextContent('runtime Secret');
    expect(hint).not.toHaveTextContent('sst secret set');
    expect(screen.queryByTestId('system-health-email-secret-hint-MAIL_PASSWORD')).not.toBeInTheDocument();
  });

  it('warns when the plaintext secrets opt-out is in effect', async () => {
    respond({ [HEALTH_URL]: () => Promise.resolve({ data: { ...HEALTH, plaintextSecretsOptOut: true } }) });
    renderTab();

    expect(await screen.findByTestId('system-health-plaintext-secrets-warning')).toHaveTextContent('unencrypted');
  });

  it('shows no plaintext secrets warning otherwise', async () => {
    respond({ [HEALTH_URL]: () => Promise.resolve({ data: { ...HEALTH, plaintextSecretsOptOut: false } }) });
    renderTab();

    // Loaded-only element: the tab testid is also rendered while loading, before any data arrives.
    await screen.findByTestId('system-health-database-status');
    expect(screen.queryByTestId('system-health-plaintext-secrets-warning')).not.toBeInTheDocument();
  });

  it('keeps the sst hint when not self-hosted', async () => {
    respond({ [HEALTH_URL]: () => Promise.resolve({ data: { ...HEALTH, selfHost: false } }) });
    renderTab();

    expect(await screen.findByTestId('system-health-email-secret-hint-MAIL_PASSWORD')).toHaveTextContent(
      'sst secret set MAIL_PASSWORD'
    );
    expect(screen.queryByTestId('system-health-email-hint')).not.toBeInTheDocument();
  });

  it('marks unset optional SMTP credentials Optional, not Missing', async () => {
    const noAuthEmail = {
      configured: true,
      transport: 'smtp',
      secrets: { MAIL_HOST: true, MAIL_PORT: true, MAIL_USERNAME: false, MAIL_PASSWORD: false, MAIL_FROM: true },
      missingSecrets: [],
      optionalSecrets: ['MAIL_USERNAME', 'MAIL_PASSWORD'],
    };
    respond({ [HEALTH_URL]: () => Promise.resolve({ data: { ...HEALTH, email: noAuthEmail } }) });
    renderTab();

    expect(await screen.findByTestId('system-health-email-delivery')).toHaveTextContent('Sent through SMTP server');
    for (const name of noAuthEmail.optionalSecrets) {
      const row = await screen.findByTestId(`system-health-email-secret-${name}`);
      expect(row).toHaveTextContent('Optional');
      expect(row).not.toHaveTextContent('Missing');
    }
  });

  it('maps integration and breaker states to tones', async () => {
    renderTab();

    expect(await screen.findByTestId('integration-health-slack-status')).toHaveAttribute('data-tone', 'good');
    expect(screen.getByTestId('integration-health-github-status')).toHaveAttribute('data-tone', 'bad');
    expect(screen.getByTestId('circuit-breaker-status-github')).toHaveAttribute('data-tone', 'bad');
    expect(screen.getByTestId('circuit-breaker-status-github')).toHaveTextContent('Tripped (auto)');
    expect(screen.getByTestId('circuit-breaker-status-slack')).toHaveAttribute('data-tone', 'good');
    expect(screen.getByTestId('circuit-breaker-block-github-btn')).toBeInTheDocument();
    expect(screen.getByTestId('circuit-breaker-force-open-github-btn')).toBeInTheDocument();
  });

  it('keeps one card level', async () => {
    const { container } = renderTab();
    await screen.findByTestId('integration-health-slack-status');

    const cards = container.querySelectorAll('[data-testid="admin-section-card"]');
    expect(cards).toHaveLength(5);
    cards.forEach(card => {
      expect(card.querySelector('[data-testid="admin-section-card"]')).toBeNull();
      expect(card.querySelector('.MuiCard-root')).toBeNull();
      expect(card.querySelector('.MuiSheet-variantOutlined')).toBeNull();
      expect(card.querySelector('.MuiAlert-root .MuiAlert-root')).toBeNull();
    });
  });

  it('sends the chosen breaker mode for the chosen integration', async () => {
    mocks.put.mockResolvedValue({ data: {} });
    renderTab();

    fireEvent.click(await screen.findByTestId('circuit-breaker-block-github-btn'));
    await waitFor(() =>
      expect(mocks.put).toHaveBeenLastCalledWith(INTEGRATIONS_URL, {
        integration: 'github',
        mode: 'force_block',
        reason: undefined,
      })
    );

    await waitFor(() => expect(screen.getByTestId('circuit-breaker-force-open-github-btn')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('circuit-breaker-force-open-github-btn'));
    await waitFor(() =>
      expect(mocks.put).toHaveBeenLastCalledWith(INTEGRATIONS_URL, {
        integration: 'github',
        mode: 'force_open',
        reason: undefined,
      })
    );

    await waitFor(() => expect(screen.getByTestId('circuit-breaker-reset-jira-btn')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('circuit-breaker-reset-jira-btn'));
    await waitFor(() =>
      expect(mocks.put).toHaveBeenLastCalledWith(INTEGRATIONS_URL, {
        integration: 'jira',
        mode: 'auto',
        reason: undefined,
      })
    );
    expect(mocks.put).toHaveBeenCalledTimes(3);
  });

  it('probes only the integration whose button was clicked', async () => {
    mocks.post.mockResolvedValue({ data: { results: [] } });
    renderTab();

    fireEvent.click(await screen.findByTestId('integration-health-probe-github-btn'));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith(INTEGRATIONS_URL, { integration: 'github' }));
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  it('shows an error state with retry when the load fails', async () => {
    respond({ [HEALTH_URL]: () => Promise.reject(new Error('boom')) });
    renderTab();

    expect(await screen.findByTestId('admin-error-state')).toBeInTheDocument();
    expect(screen.getByTestId('admin-page-header')).toBeInTheDocument();
    const before = mocks.get.mock.calls.filter(([url]) => url === HEALTH_URL).length;
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    await waitFor(() =>
      expect(mocks.get.mock.calls.filter(([url]) => url === HEALTH_URL).length).toBeGreaterThan(before)
    );
  });

  it('posts the test email to the same endpoint', async () => {
    respond({
      [HEALTH_URL]: () => Promise.resolve({ data: { ...HEALTH, email: { ...HEALTH.email, configured: true } } }),
    });
    renderTab();

    const button = await screen.findByTestId('system-health-send-test-email-btn');
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);

    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith('/api/admin/system-health/test-email', { to: undefined })
    );
  });
});

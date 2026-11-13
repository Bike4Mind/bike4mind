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

  it('maps integration and breaker states to tones', async () => {
    renderTab();

    expect(await screen.findByTestId('integration-health-slack-status')).toHaveAttribute('data-tone', 'good');
    expect(screen.getByTestId('integration-health-github-status')).toHaveAttribute('data-tone', 'bad');
    expect(screen.getByText('Tripped (auto)').closest('[data-tone]')).toHaveAttribute('data-tone', 'bad');
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
    });
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

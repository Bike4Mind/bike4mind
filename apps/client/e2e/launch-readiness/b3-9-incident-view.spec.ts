import type { IncidentSignals, IncidentState } from '../../app/components/admin/SecurityDashboard/incidentTypes';
import { test, expect } from '../fixtures';
import { TIMEOUTS } from '../constants';
import { guardLaunchReadiness } from './guard';
import { adminToken, apiUrl } from './support';

guardLaunchReadiness();

const VIEW_URL = '/admin?tab=security-dashboard&securityRange=24h';
const CARDS = ['defenses', 'queues', 'alarms', 'payments', 'more-signals'] as const;
const FAILURE_TEXT = /Could not load live signals\.|Could not load defenses, queues and payments\.|Not available/;

test.describe('B3.9 admin incident view', () => {
  test('B3.9 every incident section loads for the last 24 hours', async ({ request }) => {
    const headers = { Authorization: `Bearer ${adminToken()}` };
    const [signalsRes, stateRes] = await Promise.all([
      request.get(`${apiUrl()}/api/admin/security-dashboard/incident-signals?range=24h`, { headers }),
      request.get(`${apiUrl()}/api/admin/security-dashboard/incident-state`, { headers }),
    ]);
    expect(signalsRes.status()).toBe(200);
    expect(stateRes.status()).toBe(200);
    const signals = (await signalsRes.json()) as IncidentSignals;
    const state = (await stateRes.json()) as IncidentState;

    expect(signals.range).toBe('24h');
    const sections = {
      metrics: signals.metrics.error,
      waf: signals.waf.error,
      alarms: signals.alarms.error,
      blockLists: signals.blockLists.error,
      defenses: state.defenses.error,
      queues: state.queues.error,
      payments: state.payments.error,
    };
    expect(sections).toEqual(Object.fromEntries(Object.keys(sections).map(key => [key, undefined])));
  });

  test('B3.9 every tile and card on the incident view has data for today', async ({ page, loginAsAdmin, request }) => {
    await loginAsAdmin();
    await page.goto(VIEW_URL);

    const view = page.getByTestId('security-incident-view');
    await expect(view).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
    await expect(page.getByTestId('security-incident-tile-skeleton')).toHaveCount(0, { timeout: TIMEOUTS.ACTION });
    await expect(page.getByTestId('security-incident-as-of')).toBeVisible();

    for (const card of CARDS) {
      await expect(page.getByTestId(`security-incident-${card}-card`)).toBeVisible();
    }
    await expect(page.getByTestId('security-incident-signups-card')).toBeVisible();

    const signalsRes = await request.get(`${apiUrl()}/api/admin/security-dashboard/incident-signals?range=24h`, {
      headers: { Authorization: `Bearer ${adminToken()}` },
    });
    const wafNotConfigured = ((await signalsRes.json()) as IncidentSignals).waf.notConfigured === true;
    const tiles = ['signups', 'spend', 'alarms', 'payments', ...(wafNotConfigured ? [] : ['waf'])];
    for (const tile of tiles) {
      await expect(page.getByTestId(`security-incident-${tile}-value`), `${tile} tile`).toHaveText(/\d/);
    }

    await expect(view.getByTestId('admin-error-state')).toHaveCount(0);
    await expect(page.getByTestId('security-incident-payments-error')).toHaveCount(0);
    await expect(view.getByText(FAILURE_TEXT)).toHaveCount(0);
  });
});

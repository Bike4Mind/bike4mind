// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '@shared/auth';
import type { AccountBilling } from '@shared/account';
import { BillingSettings } from './BillingSettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

const auth: AuthState = {
  status: 'signed-in',
  environment: { preset: 'hosted', label: 'Production', url: 'https://example.invalid' },
  hostedAvailable: true,
  storage: 'available',
  busy: 'idle',
  user: { id: 'user-1' },
};
const billing: AccountBilling = {
  billingEnabled: true,
  plans: [
    {
      priceId: 'price_personal',
      name: 'Professional',
      description: 'For personal work',
      credits: 10000,
      interval: 'monthly',
      priceCents: 3000,
      currency: 'usd',
      features: ['Access to models', 'Monthly credits'],
    },
  ],
  subscriptions: [],
};
const getBilling = vi.fn<() => Promise<AccountBilling>>();
const subscribePlan = vi.fn<(priceId: string) => Promise<{ ok: true } | { ok: false; error: string }>>();
let root: Root;
let host: HTMLDivElement;
const element = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const button = (id: string) => element(id) as HTMLButtonElement;

beforeEach(() => {
  getBilling.mockReset().mockResolvedValue(billing);
  subscribePlan.mockReset().mockResolvedValue({ ok: true });
  vi.stubGlobal('b4m', { account: { getBilling, subscribePlan } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render(state: AuthState | null = auth) {
  await act(async () =>
    root.render(
      <CssVarsProvider>
        <BillingSettings auth={state} />
      </CssVarsProvider>
    )
  );
}
async function click(id: string) {
  await act(async () => button(id).click());
}

describe('personal Billing settings', () => {
  it('does not read billing or offer checkout while signed out or initializing', async () => {
    await render({ ...auth, status: 'signed-out' });
    expect(element('billing-signed-out')).not.toBeNull();
    expect(element('billing-subscribe-btn')).toBeNull();
    await render(null);
    expect(element('billing-auth-loading')).not.toBeNull();
    expect(getBilling).not.toHaveBeenCalled();
    expect(subscribePlan).not.toHaveBeenCalled();
  });

  it('shows loading rather than claiming the account is Free before the read', async () => {
    getBilling.mockReturnValue(new Promise(() => {}));
    await render();
    expect(element('billing-loading')).not.toBeNull();
    expect(element('billing-current-plan')).toBeNull();
  });

  it('presents real pricing, cadence and benefits with native plan selection', async () => {
    await render();
    expect(element('billing-plan-card')?.textContent).toContain('$30.00 / month');
    expect(element('billing-plan-card')?.textContent).toContain('10,000 credits per month');
    expect(element('billing-plan-card')?.textContent).toContain('Access to models');
    expect(button('billing-subscribe-btn').disabled).toBe(false);
    await click('billing-subscribe-btn');
    expect(subscribePlan).toHaveBeenCalledExactlyOnceWith('price_personal');
    expect(element('billing-checkout-pending')?.textContent).toContain('not confirmed');
    expect(button('billing-subscribe-btn').disabled).toBe(true);
  });

  it.each(['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete'])(
    'blocks duplicate subscription for %s current plans',
    async status => {
      getBilling.mockResolvedValue({
        ...billing,
        subscriptions: [
          {
            priceId: 'price_personal',
            subscriptionId: 'sub_1',
            status,
            periodEndsAt: '2027-01-01T00:00:00Z',
            canceledAt: null,
          },
        ],
      });
      await render();
      expect(element('billing-current-plan')?.textContent).toContain('Professional');
      expect(element('billing-current-plan')?.textContent).toContain(status.replaceAll('_', ' '));
      expect(element('billing-plan-current')).not.toBeNull();
      expect(button('billing-subscribe-btn').disabled).toBe(true);
      expect(subscribePlan).not.toHaveBeenCalled();
    }
  );

  it('does not call an unknown or canceled-at-period-end subscription Free', async () => {
    getBilling.mockResolvedValue({
      ...billing,
      subscriptions: [
        {
          priceId: 'price_old',
          subscriptionId: null,
          status: 'active',
          periodEndsAt: '2027-01-01T00:00:00Z',
          canceledAt: '2026-12-01T00:00:00Z',
        },
      ],
    });
    await render();
    expect(element('billing-current-plan')?.textContent).toContain('Subscribed');
    expect(element('billing-current-plan')?.textContent).toContain('ends');
    expect(button('billing-subscribe-btn').disabled).toBe(true);
  });

  it('shows checkout failure and permits retry', async () => {
    subscribePlan.mockResolvedValue({ ok: false, error: 'Checkout unavailable' });
    await render();
    await click('billing-subscribe-btn');
    expect(element('billing-checkout-error')?.textContent).toContain('Checkout unavailable');
    expect(element('billing-checkout-pending')).toBeNull();
    expect(button('billing-subscribe-btn').disabled).toBe(false);
  });

  it('handles a rejected bridge call without leaving checkout stuck', async () => {
    subscribePlan.mockRejectedValue(new Error('IPC unavailable'));
    await render();
    await click('billing-subscribe-btn');
    expect(element('billing-checkout-error')?.textContent).toContain('Could not open checkout');
    expect(button('billing-subscribe-btn').disabled).toBe(false);
  });

  it('locks checkout while opening and refreshes when returning from the browser', async () => {
    let opened!: (value: { ok: true }) => void;
    subscribePlan.mockReturnValue(
      new Promise(resolve => {
        opened = resolve;
      })
    );
    await render();
    await click('billing-subscribe-btn');
    await click('billing-subscribe-btn');
    expect(subscribePlan).toHaveBeenCalledTimes(1);
    expect(element('billing-checkout-pending')?.textContent).toContain('Opening checkout');
    await act(async () => opened({ ok: true }));
    getBilling.mockResolvedValue({
      ...billing,
      subscriptions: [
        {
          priceId: 'price_personal',
          subscriptionId: 'sub_new',
          status: 'active',
          periodEndsAt: null,
          canceledAt: null,
        },
      ],
    });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(getBilling).toHaveBeenCalledTimes(2);
    expect(element('billing-checkout-pending')).toBeNull();
    expect(element('billing-plan-current')).not.toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(getBilling).toHaveBeenCalledTimes(2);
  });

  it('keeps pending after a refresh with no confirmed subscription, with an explicit cancel path', async () => {
    await render();
    await click('billing-subscribe-btn');
    await click('billing-refresh-btn');
    expect(element('billing-checkout-pending')).not.toBeNull();
    await click('billing-checkout-canceled-btn');
    expect(element('billing-checkout-pending')).toBeNull();
    expect(button('billing-subscribe-btn').disabled).toBe(false);
  });

  it('shows read errors rather than Free and retries on manual refresh', async () => {
    getBilling.mockRejectedValueOnce(new Error('Offline'));
    await render();
    expect(element('billing-read-error')).not.toBeNull();
    expect(element('billing-current-plan')).toBeNull();
    await click('billing-refresh-btn');
    expect(element('billing-read-error')).toBeNull();
    expect(element('billing-current-plan')?.textContent).toContain('Free');
  });

  it('does not offer checkout for incomplete reads, disabled billing, or missing prices', async () => {
    getBilling.mockResolvedValue({ ...billing, error: 'Could not load subscriptions' });
    await render();
    expect(element('billing-current-plan')).toBeNull();
    expect(element('billing-subscribe-btn')).toBeNull();
    getBilling.mockResolvedValue({ ...billing, billingEnabled: false });
    await click('billing-refresh-btn');
    expect(element('billing-unavailable')).not.toBeNull();
    expect(element('billing-subscribe-btn')).toBeNull();
    getBilling.mockResolvedValue({ ...billing, plans: [{ ...billing.plans[0], priceCents: null }] });
    await click('billing-refresh-btn');
    expect(button('billing-subscribe-btn').disabled).toBe(true);
  });
});

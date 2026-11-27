// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountProfile, BillingAccount } from '@shared/account';
import { CreditsMenuHeader } from './CreditsGlance';
import { creditOutlook } from './creditOutlook';
import type { CreditsGlance } from './useCreditsGlance';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

const NOW = Date.parse('2026-11-24T12:00:00Z');
const PROFILE: AccountProfile = { credits: { balance: 50, monthlyAllowance: null }, plan: null, tier: 'free' };

function glanceFor(organization: BillingAccount | null): CreditsGlance {
  const balance = organization ? organization.credits : PROFILE.credits.balance;
  return {
    profile: PROFILE,
    organization,
    burnPerDay: organization ? null : 100,
    readAt: NOW,
    outlook: creditOutlook({
      balance,
      burnPerDay: organization ? 0 : 100,
      refillAt: null,
      expiring: undefined,
      now: NOW,
    }),
  };
}

let root: Root;
let host: HTMLElement;

async function render(glance: CreditsGlance, onTopUp = vi.fn()) {
  await act(async () =>
    root.render(
      <CssVarsProvider>
        <CreditsMenuHeader glance={glance} onTopUp={onTopUp} />
      </CssVarsProvider>
    )
  );
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('CreditsMenuHeader with an organization paying', () => {
  it("shows who pays and the pool's balance, with no personal runway", async () => {
    await render(glanceFor({ id: 'org-1', name: 'Acme', personal: false, credits: 48_200, seats: 4 }));
    expect(byTestId('credits-payer')?.textContent).toBe('Paid by Acme');
    expect(byTestId('credits-balance')?.textContent).toBe(`${(48_200).toLocaleString()} credits`);
    expect(byTestId('credits-glance')?.textContent).toContain('Organization pool');
    expect(byTestId('credits-ring')).toBeNull();
    expect(byTestId('credits-verdict')).toBeNull();
  });

  it('marks an empty pool, without offering a personal top-up', async () => {
    await render(glanceFor({ id: 'org-1', name: 'Acme', personal: false, credits: 0 }));
    expect(byTestId('credits-verdict')?.textContent).toBe('Out of credits.');
    expect(byTestId('credits-top-up-btn')).toBeNull();
  });

  it('says the pool balance is unavailable rather than inventing one', async () => {
    await render(glanceFor({ id: 'org-1', name: 'Acme', personal: false, credits: null }));
    expect(byTestId('credits-glance-unavailable')?.textContent).toBe('Pool balance unavailable.');
    expect(byTestId('credits-balance')).toBeNull();
  });

  it('names Personal as the payer otherwise', async () => {
    await render(glanceFor(null));
    expect(byTestId('credits-payer')?.textContent).toBe('Personal');
    expect(byTestId('credits-ring')).not.toBeNull();
  });
});

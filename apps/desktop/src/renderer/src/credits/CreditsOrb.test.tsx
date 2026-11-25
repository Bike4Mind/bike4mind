// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountProfile, BillingAccount } from '@shared/account';
import { CreditsOrb } from './CreditsOrb';
import { creditOutlook } from './creditOutlook';
import type { CreditsGlance } from './useCreditsGlance';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom ships no matchMedia, and Joy's colour-scheme provider asks for one on mount.
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

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function byTestId(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

async function mountOpen(glance: CreditsGlance) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <CssVarsProvider>
        <CreditsOrb glance={glance} onOpenChange={vi.fn()} onTopUp={vi.fn()} />
      </CssVarsProvider>
    );
  });
  await act(async () => byTestId('rail-credits-orb')?.click());
}

describe('CreditsOrb popover', () => {
  it('offers no personal Top up while an organization pays', async () => {
    const organization: BillingAccount = { id: 'org-1', name: 'Acme', personal: false, credits: 48_200 };
    const outlook = creditOutlook({ balance: 48_200, burnPerDay: 0, refillAt: null, expiring: undefined, now: NOW });
    await mountOpen({ profile: null, organization, outlook, burnPerDay: 0, readAt: NOW });
    expect(byTestId('rail-credits-payer')?.textContent).toBe('Paying: Acme');
    expect(byTestId('rail-credits-top-up-btn')).toBeNull();
    expect(byTestId('rail-credits-orb-face')?.getAttribute('data-tone')).toBe('ok');
    expect(byTestId('rail-credits-orb-face')?.textContent).toBe('48k');
    expect(byTestId('rail-credits-runway')?.textContent).toBe('Organization pool');
  });

  it('shows a healthy personal balance as text in a neutral ring, with Top up', async () => {
    const outlook = creditOutlook({ balance: 38_099, burnPerDay: 0, refillAt: null, expiring: undefined, now: NOW });
    const profile = { credits: { balance: 38_099, monthlyAllowance: null }, tier: 'free' } as AccountProfile;
    await mountOpen({ profile, organization: null, outlook, burnPerDay: null, readAt: NOW });
    expect(byTestId('rail-credits-payer')?.textContent).toBe('Paying: Personal');
    expect(byTestId('rail-credits-top-up-btn')).not.toBeNull();
    const face = byTestId('rail-credits-orb-face');
    expect(face?.getAttribute('data-tone')).toBe('ok');
    expect(face?.textContent).toBe('38k');
    expect(byTestId('rail-credits-runway')).toBeNull();
  });

  it('marks a low balance amber and says how long it lasts', async () => {
    const outlook = creditOutlook({ balance: 4212, burnPerDay: 800, refillAt: null, expiring: undefined, now: NOW });
    const profile = { credits: { balance: 4212, monthlyAllowance: null }, tier: 'free' } as AccountProfile;
    await mountOpen({ profile, organization: null, outlook, burnPerDay: 800, readAt: NOW });
    const face = byTestId('rail-credits-orb-face');
    expect(face?.getAttribute('data-tone')).toBe('low');
    expect(face?.textContent).toBe('4.2k');
    expect(byTestId('rail-credits-runway')?.textContent).toBe('About 5 days at your recent usage');
  });
});

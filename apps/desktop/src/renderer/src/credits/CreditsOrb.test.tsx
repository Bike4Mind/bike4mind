// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BillingAccount } from '@shared/account';
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
  });
});

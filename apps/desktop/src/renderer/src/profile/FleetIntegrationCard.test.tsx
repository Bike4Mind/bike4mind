// @vitest-environment jsdom
import { CssVarsProvider } from '@mui/joy/styles';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { FleetState } from '@shared/fleet';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FleetIntegrationCard } from './FleetIntegrationCard';

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

let root: Root;
let container: HTMLDivElement;
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderCard(connection: FleetState['connection'], consent: boolean, lastError: string | null = null) {
  const state: FleetState = {
    connection,
    consent,
    lastError,
    configPath: '/test/fleet.json',
    fleetUrl: null,
    email: null,
    status: 'not-configured',
    pending: 0,
    lastSentAt: null,
    lastResult: null,
  };
  const setConsent = vi.fn(async () => state);
  (window as unknown as { b4m: unknown }).b4m = {
    fleet: { refresh: async () => state, setConsent, onStateChanged: () => () => {} },
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <CssVarsProvider>
        <FleetIntegrationCard />
      </CssVarsProvider>
    )
  );
  const input = container.querySelector<HTMLInputElement>('[data-testid="fleet-consent-switch"]')!;
  return { input, setConsent };
}

describe('FleetIntegrationCard consent', () => {
  it.each(['not-installed', 'no-email', 'insecure', 'invalid'] as const)(
    'permits opt-out while %s',
    async connection => {
      const { input, setConsent } = await renderCard(connection, true);
      expect(input.disabled).toBe(false);
      await act(async () => input.click());
      expect(setConsent).toHaveBeenCalledWith(false);
    }
  );

  it.each(['not-installed', 'no-email', 'insecure', 'invalid'] as const)(
    'does not permit opt-in while %s',
    async connection => {
      const { input, setConsent } = await renderCard(connection, false);
      expect(input.disabled).toBe(true);
      await act(async () => input.click());
      expect(setConsent).not.toHaveBeenCalled();
    }
  );

  it('permits opt-in when connected', async () => {
    const { input, setConsent } = await renderCard('connected', false);
    expect(input.disabled).toBe(false);
    await act(async () => input.click());
    expect(setConsent).toHaveBeenCalledWith(true);
  });

  it('shows a clear failure while sharing is off', async () => {
    await renderCard('connected', false, 'Could not clear saved activity. Sharing stays off.');
    expect(container.querySelector('[data-testid="fleet-clear-error"]')?.textContent).toContain('Sharing stays off');
  });
});

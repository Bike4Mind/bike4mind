// @vitest-environment jsdom
import { CssVarsProvider } from '@mui/joy/styles';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AuthState } from '@shared/auth';
import type { AccountUsageResult, LocalUsageResult } from '@shared/usage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localUsageFixture } from './localUsageFixture';
import { ProfileScreen } from './ProfileScreen';

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

const STATE: AuthState = {
  status: 'signed-in',
  environment: { preset: 'hosted', url: 'https://example.invalid', label: 'Production' },
  hostedAvailable: true,
  storage: 'available',
  busy: 'idle',
  user: { id: 'user-1', nickname: 'Ada Lovelace' },
};

const NO_CREDITS: AccountUsageResult = { ok: false, error: 'Could not read your usage from this server.' };

let root: Root;
let container: HTMLDivElement;
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(local: LocalUsageResult) {
  const getLocal = vi.fn(async () => local);
  (window as unknown as { b4m: unknown }).b4m = {
    account: { getProfile: () => new Promise(() => {}) },
    usage: { getHistory: async () => NO_CREDITS, getLocal },
    fleet: { refresh: () => new Promise(() => {}), onStateChanged: () => () => {} },
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <CssVarsProvider>
        <ProfileScreen state={STATE} onClose={() => {}} />
      </CssVarsProvider>
    )
  );
  const find = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  return { getLocal, find };
}

describe('ProfileScreen local usage', () => {
  it('shows the local card under the credit section, whatever the credit read did', async () => {
    const { find } = await render({ ok: true, usage: localUsageFixture({ replies: 3, outputTokens: 90 }) });
    expect(find('profile-usage-error')).not.toBeNull();
    expect(find('profile-local-usage')).not.toBeNull();
  });

  it('hides the card for a window with no local replies', async () => {
    const { find } = await render({ ok: true, usage: localUsageFixture() });
    expect(find('profile-local-usage')).toBeNull();
  });

  it('asks again for the picked window, and past the cache on refresh', async () => {
    const { find, getLocal } = await render({ ok: true, usage: localUsageFixture({ replies: 1 }) });
    expect(getLocal).toHaveBeenLastCalledWith('last-24-hours', false);

    const thirty = container.querySelector<HTMLElement>('[data-window="last-30-days"]')!;
    await act(async () => thirty.click());
    expect(getLocal).toHaveBeenLastCalledWith('last-30-days', false);

    await act(async () => find('profile-refresh-btn')!.click());
    expect(getLocal).toHaveBeenLastCalledWith('last-30-days', true);
  });
});

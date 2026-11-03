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

async function render(local: LocalUsageResult | ((id: string) => Promise<LocalUsageResult>)) {
  const getLocal = vi.fn(typeof local === 'function' ? local : async () => local);
  (window as unknown as { b4m: unknown }).b4m = {
    account: { getProfile: () => new Promise(() => {}) },
    usage: { getHistory: async () => NO_CREDITS, getLocal },
    fleet: { refresh: () => new Promise(() => {}), onStateChanged: () => () => {} },
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const show = (state: AuthState) =>
    act(async () =>
      root.render(
        <CssVarsProvider>
          <ProfileScreen state={state} onClose={() => {}} />
        </CssVarsProvider>
      )
    );
  await show(STATE);
  const find = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  return { getLocal, find, show };
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

    const day = container.querySelector<HTMLElement>('[data-window="last-24-hours"]')!;
    await act(async () => day.click());
    expect(getLocal).toHaveBeenLastCalledWith('last-24-hours', false);
  });

  it('keeps the card on screen while another window is read', async () => {
    const { find } = await render(id =>
      id === 'last-24-hours'
        ? Promise.resolve({ ok: true, usage: localUsageFixture({ replies: 2 }) })
        : new Promise(() => {})
    );
    const thirty = container.querySelector<HTMLElement>('[data-window="last-30-days"]')!;
    await act(async () => thirty.click());
    expect(find('profile-local-usage')).not.toBeNull();
  });

  it('says so when the local read fails', async () => {
    const { find } = await render({ ok: false, error: 'Could not read local model usage.' });
    expect(find('profile-local-error')?.textContent).toBe('Could not read local model usage.');
    expect(find('profile-local-usage')).toBeNull();
  });

  it('says so when the local read rejects outright', async () => {
    const { find } = await render(() => Promise.reject(new Error('channel closed')));
    expect(find('profile-local-error')?.textContent).toBe('Could not read local model usage.');
  });

  it('drops the previous account figures when the account changes', async () => {
    let answer: (result: LocalUsageResult) => void = () => {};
    const { find, show } = await render(async () => ({ ok: true, usage: localUsageFixture({ replies: 2 }) }));
    expect(find('profile-local-usage')).not.toBeNull();

    (window as unknown as { b4m: { usage: { getLocal: unknown } } }).b4m.usage.getLocal = () =>
      new Promise<LocalUsageResult>(resolve => (answer = resolve));
    await show({ ...STATE, user: { id: 'user-2', nickname: 'Grace Hopper' } });
    expect(find('profile-local-usage')).toBeNull();

    await act(async () => answer({ ok: true, usage: localUsageFixture({ replies: 1 }) }));
    expect(find('profile-local-usage')).not.toBeNull();
  });
});

// @vitest-environment jsdom
import { CssVarsProvider } from '@mui/joy/styles';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { LocalUsageResult } from '@shared/usage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localUsageFixture } from '../profile/localUsageFixture';
import { SignedOutProfile } from './Profile';

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

async function render(result: LocalUsageResult | null) {
  const getLocal = vi.fn(() => (result ? Promise.resolve(result) : new Promise<LocalUsageResult>(() => {})));
  (window as unknown as { b4m: unknown }).b4m = { usage: { getLocal } };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <CssVarsProvider>
        <SignedOutProfile scopeKey="signed-out" onBack={() => {}} />
      </CssVarsProvider>
    )
  );
  const has = (id: string) => container.querySelector(`[data-testid="${id}"]`) !== null;
  return { getLocal, has };
}

describe('SignedOutProfile', () => {
  it('shows only the sign-in prompt when this device has no local replies', async () => {
    const usage = { ...localUsageFixture(), allTimeReplies: 0 };
    const { has } = await render({ ok: true, usage });
    expect(has('profile-signed-out')).toBe(true);
    expect(has('profile-back-btn')).toBe(true);
    expect(has('profile-local-usage')).toBe(false);
  });

  it('shows the local usage below the sign-in prompt', async () => {
    const { has, getLocal } = await render({
      ok: true,
      usage: localUsageFixture({ replies: 2, outputTokens: 50 }),
    });
    expect(getLocal).toHaveBeenCalledWith('last-24-hours', false);
    expect(has('profile-signed-out')).toBe(true);
    expect(has('profile-window-group')).toBe(true);
    expect(has('profile-local-usage')).toBe(true);
    expect(container.textContent).toContain('Sign in to see your usage');
  });

  it('says the window is empty, rather than hiding the toggle, when only older replies exist', async () => {
    const usage = { ...localUsageFixture(), allTimeReplies: 4 };
    const { has } = await render({ ok: true, usage });
    expect(has('profile-local-empty')).toBe(true);
    expect(has('profile-local-usage')).toBe(false);
    expect(has('profile-window-group')).toBe(true);
  });

  it('keeps to the sign-in prompt, with the error, when the local read fails', async () => {
    const { has } = await render({ ok: false, error: 'Could not read local model usage.' });
    expect(has('profile-signed-out')).toBe(true);
    expect(has('profile-local-error')).toBe(true);
    expect(has('profile-local-usage')).toBe(false);
  });

  it('draws neither layout until the local read answers, so it does not jump from one to the other', async () => {
    const { has } = await render(null);
    expect(has('profile-local-loading')).toBe(true);
    expect(has('profile-signed-out')).toBe(false);
  });

  it('never shows figures counted from an account folder', async () => {
    const usage = { ...localUsageFixture({ replies: 2, outputTokens: 50 }), scope: 'account' as const };
    const { has } = await render({ ok: true, usage });
    expect(has('profile-signed-out')).toBe(true);
    expect(has('profile-local-usage')).toBe(false);
    expect(has('profile-window-group')).toBe(false);
  });
});

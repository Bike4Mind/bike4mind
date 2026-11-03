// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '@shared/auth';
import { SignInCard } from './SignInCard';

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

const HOSTED = 'https://hosted.example.com';

const production: AuthState = {
  status: 'signed-out',
  environment: { preset: 'hosted', url: HOSTED, label: 'Production' },
  hostedAvailable: true,
  storage: 'available',
  busy: 'idle',
};

describe('SignInCard', () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function render(state: AuthState) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root.render(
        <CssVarsProvider>
          <SignInCard state={state} />
        </CssVarsProvider>
      )
    );
    const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`);
    return { byTestId };
  }

  it('offers Production as a single line under Sign in, with the picker collapsed', () => {
    const { byTestId } = render(production);

    expect(byTestId('auth-signin-btn')).not.toBeNull();
    expect(byTestId('signin-server-text')?.textContent).toBe(`Server: Production (${HOSTED})`);
    expect(byTestId('environment-select-btn')).toBeNull();
    expect(byTestId('environment-url-input')).toBeNull();
  });

  it('opens the picker on Change server', () => {
    const { byTestId } = render(production);

    act(() => (byTestId('signin-change-server-link') as HTMLElement).click());

    expect(byTestId('environment-select-btn')).not.toBeNull();
    expect(byTestId('signin-server-text')).toBeNull();
    // Production is still the pending choice, so no URL field to fill in.
    expect(byTestId('environment-url-input')).toBeNull();
  });

  function enterCustomUrl(byTestId: (id: string) => Element | null, url: string) {
    const input = byTestId('environment-url-input')?.querySelector('input');
    if (!input) throw new Error('Expected the custom server URL input');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setValue) throw new Error('Expected an input value setter');
    act(() => {
      setValue.call(input, url);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it.each(['https://other.example.com', `${HOSTED}/`])(
    'collapses the picker after successfully applying %s, including an unchanged normalized endpoint',
    async url => {
      const setEnvironment = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('b4m', { auth: { setEnvironment } });
      const { byTestId } = render({
        ...production,
        environment: { preset: 'custom', url: HOSTED, label: 'Remote' },
      });
      act(() => (byTestId('signin-change-server-link') as HTMLElement).click());
      enterCustomUrl(byTestId, url);

      await act(async () => (byTestId('environment-apply-btn') as HTMLButtonElement).click());

      expect(setEnvironment).toHaveBeenCalledExactlyOnceWith({ preset: 'custom', customUrl: url });
      expect(byTestId('environment-select-btn')).toBeNull();
      expect(byTestId('signin-change-server-link')).not.toBeNull();
    }
  );

  it('keeps the picker and its error visible after an unsuccessful apply', async () => {
    const setEnvironment = vi.fn().mockResolvedValue({ ok: false, error: 'Invalid server URL' });
    vi.stubGlobal('b4m', { auth: { setEnvironment } });
    const { byTestId } = render({
      ...production,
      environment: { preset: 'custom', url: HOSTED, label: 'Remote' },
    });
    act(() => (byTestId('signin-change-server-link') as HTMLElement).click());
    enterCustomUrl(byTestId, 'invalid');

    await act(async () => (byTestId('environment-apply-btn') as HTMLButtonElement).click());

    expect(setEnvironment).toHaveBeenCalledExactlyOnceWith({ preset: 'custom', customUrl: 'invalid' });
    expect(byTestId('environment-select-btn')).not.toBeNull();
    expect(byTestId('environment-error-alert')?.textContent).toBe('Invalid server URL');
    expect(byTestId('signin-server-text')).toBeNull();
    expect((byTestId('environment-apply-btn') as HTMLButtonElement).disabled).toBe(false);
  });

  it('leaves the picker open when no server resolves', () => {
    const { byTestId } = render({
      ...production,
      status: 'unconfigured',
      hostedAvailable: false,
      environment: { preset: 'custom', url: '', label: 'Unconfigured' },
    });

    expect(byTestId('environment-select-btn')).not.toBeNull();
    expect(byTestId('signin-change-server-link')).toBeNull();
    expect(byTestId('auth-signin-btn')).toBeNull();
  });

  it('does not let the server change while a sign-in is in flight', () => {
    const { byTestId } = render({ ...production, busy: 'signing-in' });

    const link = byTestId('signin-change-server-link') as HTMLElement;
    act(() => link.click());

    expect(link.getAttribute('aria-disabled')).toBe('true');
    expect(byTestId('environment-select-btn')).toBeNull();
  });
});

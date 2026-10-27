// @vitest-environment jsdom
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { AuthState } from '@shared/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Home } from './Home';
import { setLocalChatActive } from './localChatMode';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));

// The real shell pulls in the whole chat stack; what matters here is whether Home keeps it
// mounted, which a draft held in its own state shows directly.
vi.mock('../chat/ChatShell', () => ({
  ChatShell: ({ account }: { account?: (status: null) => ReactNode }) => {
    const [draft, setDraft] = useState('');
    return (
      <>
        <textarea data-testid="composer-input" value={draft} onChange={event => setDraft(event.target.value)} />
        {account?.(null)}
      </>
    );
  },
}));
vi.mock('../auth/SignedInPanel', () => ({ SignedInPanel: () => null }));
vi.mock('../chat/UpdateNotice', () => ({ AppUpdateNotice: () => null }));

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

const base: AuthState = {
  status: 'signed-in',
  environment: { preset: 'hosted', label: 'Production', url: 'https://example.invalid' },
  hostedAvailable: true,
  storage: 'available',
  busy: 'idle',
  user: { id: 'u1' },
};

const expired: AuthState = {
  ...base,
  status: 'signed-out',
  reauthRequired: true,
  error: { message: 'Your session expired. Sign in again to continue.', remedy: 'retry-sign-in' },
};

let root: Root | null = null;
let host: HTMLElement | null = null;
let push: (state: AuthState) => void = () => {};
const signIn = vi.fn(async () => {});

beforeEach(() => {
  navigate.mockClear();
  (window as unknown as { b4m: unknown }).b4m = {
    auth: {
      getState: async () => base,
      onStateChanged: (listener: (state: AuthState) => void) => {
        push = listener;
        return () => {};
      },
      signIn,
      cancelSignIn: vi.fn(async () => {}),
      openAccountPage: vi.fn(async () => {}),
    },
  };
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  signIn.mockClear();
  setLocalChatActive(false);
});

async function mount(): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <CssVarsProvider>
        <Home />
      </CssVarsProvider>
    );
  });
}

function byTestId(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

function type(element: HTMLElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('Home when the session expires mid-conversation', () => {
  it('shows one sign-in notice over the conversation and keeps the draft', async () => {
    await mount();
    const composer = byTestId('composer-input') as HTMLTextAreaElement;
    type(composer, 'half-written message');

    act(() => push(expired));

    expect(byTestId('reauth-notice-alert')?.textContent).toContain('Your session expired. Sign in again to continue.');
    expect(document.querySelectorAll('[data-testid="reauth-notice-alert"]')).toHaveLength(1);
    expect(byTestId('composer-input')).toBe(composer);
    expect(composer.value).toBe('half-written message');
    expect(byTestId('auth-signin-btn')).toBeNull();

    act(() => byTestId('reauth-signin-btn')?.click());
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it('shows the device code in a dialog while approval is pending, then drops the notice once signed in', async () => {
    await mount();
    const composer = byTestId('composer-input') as HTMLTextAreaElement;
    type(composer, 'still here');

    act(() =>
      push({
        ...expired,
        status: 'awaiting-approval',
        busy: 'signing-in',
        pending: {
          userCode: 'WDJB-MJHT',
          verificationUri: 'https://example.invalid/activate',
          verificationUriComplete: 'https://example.invalid/activate?code=WDJB-MJHT',
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          browserOpened: true,
        },
      })
    );
    expect(byTestId('auth-user-code-text')?.textContent).toBe('WDJB-MJHT');

    act(() => push(base));

    expect(byTestId('reauth-notice-alert')).toBeNull();
    expect(byTestId('composer-input')).toBe(composer);
    expect(composer.value).toBe('still here');
  });

  it('shows the full sign-in card for a plain sign-out', async () => {
    await mount();

    act(() => push({ ...base, status: 'signed-out', user: undefined }));

    expect(byTestId('composer-input')).toBeNull();
    expect(byTestId('auth-signin-btn')).not.toBeNull();
  });
});

it.each(['signed-out', 'unconfigured'] as const)('opens local chat without signing in from %s', async status => {
  await mount();
  act(() => push({ ...base, status, user: undefined }));
  expect(byTestId('composer-input')).toBeNull();
  act(() => byTestId('auth-local-chat-btn')?.click());
  expect(byTestId('composer-input')).not.toBeNull();
  expect(signIn).not.toHaveBeenCalled();
  act(() => byTestId('local-chat-settings-btn')?.click());
  expect(navigate).toHaveBeenCalledWith({ to: '/settings' });
  act(() => byTestId('local-chat-signin-btn')?.click());
  expect(byTestId('composer-input')).toBeNull();
  expect(byTestId('auth-local-chat-btn')).not.toBeNull();
});

it('returns to local chat after Home unmounts for Settings and mounts again', async () => {
  await mount();
  act(() => push({ ...base, status: 'signed-out', user: undefined }));
  act(() => byTestId('auth-local-chat-btn')?.click());
  act(() => byTestId('local-chat-settings-btn')?.click());
  act(() => root?.unmount());
  host?.remove();

  const signedOut: AuthState = { ...base, status: 'signed-out', user: undefined };
  (window as unknown as { b4m: { auth: { getState: () => Promise<AuthState> } } }).b4m.auth.getState = async () =>
    signedOut;
  await mount();
  expect(byTestId('composer-input')).not.toBeNull();
  expect(byTestId('auth-local-chat-btn')).toBeNull();
});

it('shows the sign-in card after signing out of an account that arrived during local chat', async () => {
  await mount();
  act(() => push({ ...base, status: 'signed-out', user: undefined }));
  act(() => byTestId('auth-local-chat-btn')?.click());
  act(() => push(base));
  act(() => push({ ...base, status: 'signed-out', user: undefined }));
  expect(byTestId('auth-local-chat-btn')).not.toBeNull();
  expect(byTestId('composer-input')).toBeNull();
});

it('replaces the local conversation view when an authenticated account becomes active', async () => {
  await mount();
  act(() => push({ ...base, status: 'signed-out', user: undefined }));
  act(() => byTestId('auth-local-chat-btn')?.click());
  const composer = byTestId('composer-input') as HTMLTextAreaElement;
  type(composer, 'device-only draft');
  act(() => push(base));
  expect(byTestId('composer-input')).not.toBe(composer);
  expect((byTestId('composer-input') as HTMLTextAreaElement).value).toBe('');
});

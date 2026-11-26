// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '@shared/auth';
import { initialUpdateState, reduceUpdate, type UpdateStatus } from '@shared/update';
import type { AppUpdateController } from '../chat/useAppUpdate';
import type { RailAccountContext } from '../chat/rail/PlaceRail';
import { LocalRailAccount, SignedInRailAccount, updateNextStep } from './RailAccount';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));

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

const signedIn: AuthState = {
  status: 'signed-in',
  environment: { preset: 'hosted', label: 'Production', url: 'https://example.invalid' },
  hostedAvailable: true,
  storage: 'available',
  busy: 'idle',
  user: { id: 'u1', nickname: 'Jude', email: 'jude@example.invalid' },
};

const available = reduceUpdate(initialUpdateState('0.1.10', true), { type: 'available', version: '0.2.0', at: 1 });

function controllerIn(status: UpdateStatus): AppUpdateController {
  return {
    state: { ...available, status },
    blockedBy: null,
    downloadFailed: false,
    check: vi.fn(),
    download: vi.fn(),
    install: vi.fn(async () => false),
    dismissBlock: vi.fn(),
    dismiss: vi.fn(),
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  navigate.mockClear();
});

function contextWith(overrides: Partial<RailAccountContext> = {}): RailAccountContext {
  return { status: null, onOpenCustomize: vi.fn(), onOpenModels: vi.fn(), ...overrides };
}

const pending = () => new Promise(() => {});

function mount(node: React.ReactNode, bridge: Record<string, unknown> = {}) {
  (window as unknown as { b4m: unknown }).b4m = {
    // The avatar reads the credits glance on mount; left pending unless a test brings its own.
    account: { getProfile: pending, getSelection: pending, onSelectionChanged: () => () => {} },
    usage: { getHistory: pending },
    ...bridge,
    getAppInfo: () => new Promise(() => {}),
    attention: { openServerSessions: vi.fn(async () => {}) },
    auth: { signOut: vi.fn(async () => {}), retryIdentity: vi.fn(async () => {}) },
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(<CssVarsProvider>{node}</CssVarsProvider>);
  });
}

/** A credits bridge: `balance` left, and `creditsSpent` burned yesterday, on a monthly plan. */
function creditsBridge(balance: number, creditsSpent: number) {
  // The burn rate divides by the time since the bar began, so the bar starts exactly a day ago:
  // anchored to midnight, the runway would depend on the hour the test runs.
  const barStartsAt = new Date(Date.now() - 86_400_000).toISOString();
  return {
    account: {
      getSelection: pending,
      onSelectionChanged: () => () => {},
      getProfile: async () => ({
        credits: { balance, monthlyAllowance: 10_000 },
        plan: {
          name: 'Pro',
          interval: 'monthly',
          currentPeriodEndsAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
        },
        tier: 'pro',
      }),
    },
    usage: {
      getHistory: async () => ({
        ok: true,
        usage: {
          bars: [{ startsAt: barStartsAt, creditsSpent, requests: 1 }],
        },
      }),
    },
  };
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const open = () => act(() => byTestId('place-rail-account-btn')?.click());
const rowIds = () =>
  [...document.querySelectorAll('[data-testid="account-menu"] [role="menuitem"]')].map(row =>
    row.getAttribute('data-testid')
  );

describe('the rail avatar, signed in', () => {
  it('keeps the menu shut until it is asked for', () => {
    mount(<SignedInRailAccount state={signedIn} update={controllerIn('idle')} context={contextWith()} />);
    expect(byTestId('place-rail-account-btn')).not.toBeNull();
    expect(byTestId('account-settings-btn')).toBeNull();
  });

  it('lists Settings, Customize, Models, Billing, Profile and Sign out, in that order', () => {
    mount(<SignedInRailAccount state={signedIn} update={controllerIn('idle')} context={contextWith()} />);
    open();
    expect(rowIds()).toEqual([
      'account-settings-btn',
      'account-customize-btn',
      'account-models-btn',
      'account-billing-btn',
      'account-profile-btn',
      'account-feedback-btn',
      'account-open-web-btn',
      'auth-signout-btn',
    ]);
  });

  it('heads the menu with who is signed in and which deployment replies come from', () => {
    mount(
      <SignedInRailAccount
        state={signedIn}
        update={controllerIn('idle')}
        context={contextWith({ status: <span data-testid="turn-dot-probe" /> })}
      />
    );
    open();
    const header = byTestId('account-menu-header');
    expect(byTestId('auth-status-chip')?.textContent).toBe('Jude');
    expect(byTestId('account-menu-email')?.textContent).toBe('jude@example.invalid');
    expect(header?.textContent).toContain('Production');
    expect(header?.contains(byTestId('turn-dot-probe'))).toBe(true);
  });

  it('opens the shell screens for Customize and Models, and the routes for the rest', () => {
    const context = contextWith();
    mount(<SignedInRailAccount state={signedIn} update={controllerIn('idle')} context={context} />);
    open();
    act(() => byTestId('account-customize-btn')?.click());
    expect(context.onOpenCustomize).toHaveBeenCalledTimes(1);
    open();
    act(() => byTestId('account-models-btn')?.click());
    expect(context.onOpenModels).toHaveBeenCalledTimes(1);
    for (const [id, to] of [
      ['account-settings-btn', '/settings'],
      ['account-billing-btn', '/billing'],
      ['account-profile-btn', '/profile'],
    ] as const) {
      open();
      act(() => byTestId(id)?.click());
      expect(navigate).toHaveBeenLastCalledWith({ to });
    }
  });

  it.each([
    { ...signedIn, status: 'signed-out' as const },
    { ...signedIn, user: undefined },
  ])('hides Billing without a signed-in user', state => {
    mount(<SignedInRailAccount state={state} update={controllerIn('idle')} context={contextWith()} />);
    open();
    expect(byTestId('account-billing-btn')).toBeNull();
  });

  it('labels the web-app row as leaving for the web app, not as syncing web conversations', async () => {
    mount(<SignedInRailAccount state={signedIn} update={controllerIn('idle')} context={contextWith()} />);
    open();
    const row = byTestId('account-open-web-btn');
    expect(row?.textContent).toBe('Open Bike4Mind web');
    expect(document.body.textContent).not.toContain('web conversations');
    await act(async () => {
      row?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 200));
    });
    expect(document.body.textContent).toContain('Opens the web app in your browser');
  });

  it('asks main to open the web app in the browser', () => {
    mount(<SignedInRailAccount state={signedIn} update={controllerIn('idle')} context={contextWith()} />);
    open();
    act(() => byTestId('account-open-web-btn')?.click());
    const b4m = (window as unknown as { b4m: { attention: { openServerSessions: () => void } } }).b4m;
    expect(b4m.attention.openServerSessions).toHaveBeenCalledExactlyOnceWith();
  });

  it('shows no dot when nothing needs the user', () => {
    mount(<SignedInRailAccount state={signedIn} update={controllerIn('idle')} context={contextWith()} />);
    expect(byTestId('place-rail-account-dot')).toBeNull();
  });

  it('moves the Customize attention to a warning dot on the avatar and a chip on its row', () => {
    mount(
      <SignedInRailAccount
        state={signedIn}
        update={controllerIn('idle')}
        context={contextWith({ customizeAttention: '1 failed' })}
      />
    );
    expect(byTestId('place-rail-account-dot')?.dataset.tone).toBe('warning');
    open();
    expect(byTestId('customize-attention-chip')?.textContent).toBe('1 failed');
  });

  it('marks the avatar and heads the menu with a sign-in error', () => {
    mount(
      <SignedInRailAccount
        state={{ ...signedIn, error: { message: 'Could not reach the server.' } } as AuthState}
        update={controllerIn('idle')}
        context={contextWith()}
      />
    );
    expect(byTestId('place-rail-account-dot')?.dataset.tone).toBe('warning');
    open();
    expect(byTestId('auth-error-alert')?.textContent).toContain('Could not reach the server.');
  });
});

describe('the rail avatar with an update waiting', () => {
  const chipButton = () => byTestId('account-attention-chip')?.querySelector('button') ?? null;

  it('shows a quiet dot, and a Settings chip that is not a failure', () => {
    mount(<SignedInRailAccount state={signedIn} update={controllerIn('ready')} context={contextWith()} />);
    expect(byTestId('place-rail-account-dot')?.dataset.tone).toBe('neutral');
    open();
    expect(byTestId('account-settings-attention-chip')?.textContent).toBe('Restart');
    expect(byTestId('account-settings-attention-chip')?.className).not.toContain('colorDanger');
  });

  it('starts the download when the Update label is clicked', () => {
    const update = controllerIn('available');
    mount(<SignedInRailAccount state={signedIn} update={update} context={contextWith()} />);
    open();
    expect(byTestId('account-attention-chip')?.textContent).toBe('Update');
    act(() => chipButton()?.click());
    expect(update.download).toHaveBeenCalledTimes(1);
  });

  it('starts the restart from the Restart label', () => {
    const update = controllerIn('ready');
    mount(<SignedInRailAccount state={signedIn} update={update} context={contextWith()} />);
    open();
    act(() => chipButton()?.click());
    expect(update.install).toHaveBeenCalledWith(false);
    expect(update.download).not.toHaveBeenCalled();
  });

  it('offers nothing to click while the download runs, so it is never started twice', () => {
    const update = controllerIn('downloading');
    mount(<SignedInRailAccount state={signedIn} update={update} context={contextWith()} />);
    open();
    expect(chipButton()).toBeNull();
  });
});

describe('the rail avatar in local chat', () => {
  it('offers Settings, Customize, Models and Sign in', () => {
    const onSignIn = vi.fn();
    mount(<LocalRailAccount context={contextWith()} onSignIn={onSignIn} />);
    open();
    expect(rowIds()).toEqual([
      'local-chat-settings-btn',
      'account-customize-btn',
      'account-models-btn',
      'local-chat-signin-btn',
    ]);
    act(() => byTestId('local-chat-signin-btn')?.click());
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });
});

describe('the next step the update label takes', () => {
  it('downloads an offer and restarts into a downloaded update', () => {
    const offer = controllerIn('available');
    updateNextStep(offer)?.();
    expect(offer.download).toHaveBeenCalledTimes(1);

    const staged = controllerIn('ready');
    updateNextStep(staged)?.();
    expect(staged.install).toHaveBeenCalledWith(false);
    expect(staged.download).not.toHaveBeenCalled();
  });

  it.each<UpdateStatus>(['downloading', 'checking', 'idle', 'up-to-date', 'unreachable', 'unsupported'])(
    'has none while %s',
    status => {
      expect(updateNextStep(controllerIn(status))).toBeUndefined();
    }
  );
});

const PINNED_NOW = new Date('2026-06-15T12:00:00Z');

describe('the credits orb above the rail avatar', () => {
  // The runway math reads the clock, so pin it: the outcome must not depend on when the suite runs.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(PINNED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function mountWith(balance: number, creditsSpent: number) {
    mount(
      <SignedInRailAccount state={signedIn} update={controllerIn('idle')} context={contextWith()} />,
      creditsBridge(balance, creditsSpent)
    );
    await act(async () => undefined);
  }

  it('sits directly above the avatar, and the avatar carries no credits dot', async () => {
    await mountWith(300_000, 1000);
    const orb = byTestId('rail-credits-orb');
    expect(orb?.nextElementSibling).toBe(byTestId('place-rail-account-btn'));
    expect(byTestId('credits-avatar-dot')).toBeNull();
  });

  it('stays quiet while credits are fine', async () => {
    await mountWith(300_000, 1000);
    expect(byTestId('rail-credits-orb')?.getAttribute('data-tone')).toBe('ok');
    expect(byTestId('rail-credits-orb')?.getAttribute('aria-label')).toBe(
      `Credits: ok, ${(300_000).toLocaleString()} credits`
    );
  });

  it('opens the balance and runway at the top of the account menu', async () => {
    await mountWith(300_000, 1000);
    await act(async () => byTestId('place-rail-account-btn')?.click());
    const glance = byTestId('credits-glance');
    expect(byTestId('account-menu')?.firstElementChild).toBe(glance);
    expect(byTestId('credits-balance')?.textContent).toBe(`${(300_000).toLocaleString()} credits`);
    expect(byTestId('credits-verdict')?.textContent).toBe("More than a month left at last week's pace.");
    expect(byTestId('credits-top-up-btn')).toBeNull();
  });

  it('turns low and offers a top-up in the account menu when credits run out before the refill', async () => {
    await mountWith(4000, 1000);
    expect(byTestId('rail-credits-orb')?.getAttribute('data-tone')).toBe('low');
    expect(byTestId('rail-credits-orb')?.getAttribute('aria-label')).toMatch(/^Credits: running low/);
    await act(async () => byTestId('place-rail-account-btn')?.click());
    expect(byTestId('credits-verdict')?.textContent).toMatch(/^Runs out /);
    expect(byTestId('credits-top-up-btn')).not.toBeNull();
  });

  it('opens a popover with the balance, the payer and Top up, which goes to billing', async () => {
    await mountWith(4000, 1000);
    await act(async () => byTestId('rail-credits-orb')?.click());
    expect(byTestId('rail-credits-balance')?.textContent).toBe(`${(4000).toLocaleString()} credits`);
    expect(byTestId('rail-credits-payer')?.textContent).toBe('Paying: Personal');
    await act(async () => byTestId('rail-credits-top-up-btn')?.click());
    expect(navigate).toHaveBeenCalledWith({ to: '/billing' });
  });

  it('adds no credit reads while idle: only the mount read, however long the window sits open', async () => {
    vi.useFakeTimers();
    try {
      const bridge = creditsBridge(4000, 1000);
      const getProfile = vi.fn(bridge.account.getProfile);
      const getHistory = vi.fn(bridge.usage.getHistory);
      mount(<SignedInRailAccount state={signedIn} update={controllerIn('idle')} context={contextWith()} />, {
        account: { ...bridge.account, getProfile },
        usage: { getHistory },
      });
      await act(async () => undefined);
      await act(async () => vi.advanceTimersByTimeAsync(10 * 60_000));
      expect(getProfile).toHaveBeenCalledTimes(1);
      expect(getHistory).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

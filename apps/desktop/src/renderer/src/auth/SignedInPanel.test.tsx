// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '@shared/auth';
import { initialUpdateState, reduceUpdate, type UpdateStatus } from '@shared/update';
import type { AppUpdateController } from '../chat/useAppUpdate';
import { AccountMenu, SignedInPanel, updateNextStep } from './SignedInPanel';

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

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

/** Rendered to a string where nothing has to be clicked. */
const markup = (node: React.ReactNode) => renderToStaticMarkup(<CssVarsProvider>{node}</CssVarsProvider>);

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

describe('the account strip', () => {
  const html = markup(<SignedInPanel state={signedIn} update={controllerIn('idle')} />);

  it('keeps showing which deployment replies come from', () => {
    expect(html).toContain('Production');
  });

  // The picker moved to Settings; leaving a second live one here is how the two drift apart.
  it('does not mount a server picker of its own', () => {
    expect(html).not.toContain('data-testid="environment-select-btn"');
  });

  it('keeps the menu shut until it is asked for', () => {
    expect(html).not.toContain('data-testid="account-menu"');
  });
});

describe('the account menu', () => {
  const html = markup(
    <AccountMenu state={signedIn} onOpenSettings={() => {}} onProfile={() => {}} onSendFeedback={() => {}} />
  );

  it('offers Send Feedback in the avatar menu', () => {
    expect(html).toContain('data-testid="account-feedback-btn"');
    expect(html).toContain('Send Feedback');
  });

  /**
   * Settings has no nav row - a second config row under Customize said the same thing twice -
   * so this menu is the only way in, and the one that has to keep working.
   */
  it('is the way into Settings', () => {
    expect(html).toContain('data-testid="account-settings-btn"');
  });

  it('offers no Settings row when the shell gave it no way to open one', () => {
    const noOpener = markup(<AccountMenu state={signedIn} onProfile={() => {}} />);
    expect(noOpener).not.toContain('data-testid="account-settings-btn"');
  });

  it('offers Billing for a signed-in user', () => {
    const html = markup(<AccountMenu state={signedIn} onBilling={() => {}} onProfile={() => {}} />);
    expect(html).toContain('data-testid="account-billing-btn"');
  });

  it.each([
    { ...signedIn, status: 'signed-out' as const },
    { ...signedIn, user: undefined },
  ])('hides Billing without a signed-in user', state => {
    const html = markup(<AccountMenu state={state} onBilling={() => {}} onProfile={() => {}} />);
    expect(html).not.toContain('data-testid="account-billing-btn"');
  });

  /** Primary, not danger: a waiting update is not a fault the user has to go and fix. */
  it('draws a waiting update on the Settings row, not as a failure', () => {
    const waiting = markup(
      <AccountMenu state={signedIn} attention="Restart" onOpenSettings={() => {}} onProfile={() => {}} />
    );
    expect(waiting).toContain('data-testid="account-settings-attention-chip"');
    expect(waiting).not.toContain('MuiChip-colorDanger');
  });
});

describe('the account strip with an update waiting', () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  function mount(update: AppUpdateController) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root?.render(
        <CssVarsProvider>
          <SignedInPanel state={signedIn} update={update} />
        </CssVarsProvider>
      );
    });
  }

  const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const chipButton = () => byTestId('account-attention-chip')?.querySelector('button') ?? null;

  it('starts the download when the Update label is clicked', () => {
    const update = controllerIn('available');
    mount(update);

    expect(byTestId('account-attention-chip')?.textContent).toBe('Update');
    act(() => chipButton()?.click());
    expect(update.download).toHaveBeenCalledTimes(1);
  });

  it('starts the restart from the Restart label', () => {
    const update = controllerIn('ready');
    mount(update);

    expect(byTestId('account-attention-chip')?.textContent).toBe('Restart');
    act(() => chipButton()?.click());
    expect(update.install).toHaveBeenCalledWith(false);
    expect(update.download).not.toHaveBeenCalled();
  });

  it('offers nothing to click while the download runs, so it is never started twice', () => {
    const update = controllerIn('downloading');
    mount(update);

    expect(chipButton()).toBeNull();
    act(() => byTestId('account-attention-chip')?.click());
    expect(update.download).not.toHaveBeenCalled();
  });

  it('draws no update card in the footer; the card floats on its own', () => {
    (window as unknown as { b4m: unknown }).b4m = { getAppInfo: () => new Promise(() => {}) };
    mount(controllerIn('available'));
    act(() => byTestId('account-menu-btn')?.click());
    expect(byTestId('update-notice')).toBeNull();
  });

  describe('the next step the label takes', () => {
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
});

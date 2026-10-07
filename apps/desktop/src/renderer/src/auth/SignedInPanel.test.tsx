import { CssVarsProvider } from '@mui/joy/styles';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AuthState } from '@shared/auth';
import { AccountMenu, SignedInPanel } from './SignedInPanel';

/** Rendered to a string, like the other renderer tests: this package's vitest runs on `node`. */
const markup = (node: React.ReactNode) => renderToStaticMarkup(<CssVarsProvider>{node}</CssVarsProvider>);

const signedIn: AuthState = {
  status: 'signed-in',
  environment: { preset: 'hosted', label: 'Production', url: 'https://example.invalid' },
  hostedAvailable: true,
  storage: 'available',
  busy: 'idle',
  user: { id: 'u1', nickname: 'Jude', email: 'jude@example.invalid' },
};

describe('the account strip', () => {
  const html = markup(<SignedInPanel state={signedIn} onOpenSettings={() => {}} />);

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
  const html = markup(<AccountMenu state={signedIn} onOpenSettings={() => {}} onProfile={() => {}} />);

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

  /** Primary, not danger: a waiting update is not a fault the user has to go and fix. */
  it('draws a waiting update on the Settings row, not as a failure', () => {
    const waiting = markup(
      <AccountMenu state={signedIn} attention="Restart" onOpenSettings={() => {}} onProfile={() => {}} />
    );
    expect(waiting).toContain('data-testid="account-settings-attention-chip"');
    expect(waiting).not.toContain('MuiChip-colorDanger');
  });
});

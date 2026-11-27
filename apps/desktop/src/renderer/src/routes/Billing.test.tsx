import { CssVarsProvider } from '@mui/joy/styles';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AuthState } from '@shared/auth';

const state = vi.hoisted(() => ({ auth: null as AuthState | null }));
vi.mock('../auth/useAuthState', () => ({ useAuthState: () => state.auth }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
import { Billing } from './Billing';

const markup = () =>
  renderToStaticMarkup(
    <CssVarsProvider>
      <Billing />
    </CssVarsProvider>
  );

describe('standalone Billing screen', () => {
  it('has its own screen and back navigation while checking sign-in', () => {
    state.auth = null;
    const html = markup();
    expect(html).toContain('data-testid="billing-screen"');
    expect(html).toContain('data-testid="billing-back-btn"');
    expect(html).toContain('billing-auth-loading');
    expect(html).not.toContain('settings-nav');
  });

  it('does not offer purchases to signed-out users', () => {
    state.auth = {
      status: 'signed-out',
      environment: { preset: 'local', label: 'Local', url: 'http://localhost:3000' },
      hostedAvailable: true,
      storage: 'available',
      busy: 'idle',
    };
    const html = markup();
    expect(html).toContain('billing-signed-out');
    expect(html).not.toContain('billing-top-up-btn');
  });

  it('loads billing directly for a signed-in user', () => {
    state.auth = { ...state.auth!, status: 'signed-in', user: { id: 'u1' } };
    expect(markup()).toContain('billing-loading');
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { AuthState } from '@shared/auth';
import { closeBrowsersOnScopeChange } from './browserScope';

const signedIn: AuthState = {
  status: 'signed-in',
  environment: { preset: 'hosted', url: 'https://example.com', label: 'Hosted' },
  hostedAvailable: true,
  storage: 'available',
  busy: 'idle',
  user: { id: 'account-a' },
};

describe('browser account boundaries', () => {
  it('closes pages on account and environment changes even when session ids recur', () => {
    const close = vi.fn();
    const changed = closeBrowsersOnScopeChange(signedIn, close);
    changed({ ...signedIn, user: { id: 'account-b' } });
    changed({
      ...signedIn,
      user: { id: 'account-b' },
      environment: { ...signedIn.environment, url: 'https://other.com' },
    });
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('closes pages between authenticated, device-local, and unknown scopes', () => {
    const close = vi.fn();
    const changed = closeBrowsersOnScopeChange(signedIn, close);
    const local: AuthState = { ...signedIn, status: 'signed-out', user: undefined };
    changed(local);
    changed({ ...local, status: 'unconfigured' });
    expect(close).toHaveBeenCalledOnce();
    changed({ ...local, status: 'initializing' });
    changed(signedIn);
    expect(close).toHaveBeenCalledTimes(3);
  });

  it('preserves pages during expiry and restoration of the same identified account', () => {
    const close = vi.fn();
    const changed = closeBrowsersOnScopeChange(signedIn, close);
    changed({ ...signedIn, status: 'signed-out', reauthRequired: true });
    changed({ ...signedIn, status: 'initializing', reauthRequired: true });
    changed(signedIn);
    expect(close).not.toHaveBeenCalled();
  });
});

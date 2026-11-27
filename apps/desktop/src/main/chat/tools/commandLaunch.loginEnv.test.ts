import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandEnv, launchCommand } from './commandLaunch';

vi.mock('./userPath', () => ({
  resolveUserPath: async () => '/login/bin:/usr/bin',
  resolveLoginShellVariables: async () => ({
    B4M_TEST_LOGIN_ONLY: 'from-login-shell',
    B4M_TEST_LOGIN_LANG: 'en_US.UTF-8',
    SHARED: 'login',
  }),
}));

describe.skipIf(process.platform === 'win32')('commandEnv with login-shell variables', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('fills in what the app environment lacks from the login shell, with the login PATH', async () => {
    const launch = await launchCommand('true', [], [], process.cwd());

    const env = await commandEnv(launch);

    expect(env.B4M_TEST_LOGIN_ONLY).toBe('from-login-shell');
    expect(env.B4M_TEST_LOGIN_LANG).toBe('en_US.UTF-8');
    expect(env.PATH).toBe('/login/bin:/usr/bin');
  });

  it("keeps the app's own value over the login shell's, and the caller's extras over both", async () => {
    vi.stubEnv('SHARED', 'app');
    vi.stubEnv('B4M_TEST_LOGIN_ONLY', 'from-app');
    const launch = await launchCommand('true', [], [], process.cwd());

    const env = await commandEnv(launch, { SHARED: 'extra' });

    expect(env.B4M_TEST_LOGIN_ONLY).toBe('from-app');
    expect(env.SHARED).toBe('extra');
  });
});

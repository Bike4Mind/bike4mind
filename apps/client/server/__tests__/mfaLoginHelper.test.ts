import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRequestContext, Page, Response } from '@playwright/test';
import type { LoginPage } from '../../e2e/pages/LoginPage';

const helpers = vi.hoisted(() => ({ otc: vi.fn(), mfa: vi.fn(), fillInput: vi.fn() }));
vi.mock('../../e2e/helpers/api', () => ({
  apiGetOtcCode: helpers.otc,
  apiGetMfaCode: helpers.mfa,
  refreshTokenFromSetCookie: vi.fn(),
}));
vi.mock('../../e2e/pages/BasePage', () => ({
  BasePage: class {
    fillMuiInput = helpers.fillInput;
  },
}));
vi.mock('@playwright/test', async () => {
  const { expect: assertion } = await import('vitest');
  return {
    expect: Object.assign(
      (value: unknown, message?: string) => {
        if (typeof value === 'object' && value !== null && 'fixtureLocator' in value) {
          return {
            toBeVisible: async () => assertion(value.fixtureLocator).toBe(true),
            toBeHidden: async () => assertion(value.fixtureLocator).toBe(true),
          };
        }
        return assertion(value, message);
      },
      {
        poll: (read: () => unknown) => ({ toBeTruthy: async () => assertion(await read()).toBeTruthy() }),
      }
    ),
  };
});

import { signInThroughForm } from '../../e2e/helpers/signInThroughForm';

const EMAIL = 'fixture-existing-user@example.test';
const request = {} as unknown as APIRequestContext;
type ResponseListener = (response: Response) => void | Promise<void>;
const response = (path: string, body: Record<string, unknown>) => ({
  url: () => `https://fixture.example.test${path}`,
  request: () => ({ method: () => 'POST' }),
  ok: () => true,
  status: () => 200,
  json: vi.fn(async () => body),
});
type FixtureResponse = ReturnType<typeof response>;
const browserResponse = (value: FixtureResponse) => value as unknown as Response;

function fixture(mode: 'enrolled' | 'direct' | 'setup', holdSetup = false) {
  const body = mode === 'enrolled' ? { mfaRequired: true } : mode === 'setup' ? { mfaSetupRequired: true } : {};
  const otcResponse = response('/api/otc/verify', body);
  const setupResponse = response('/api/auth/mfa/setup', { secret: 'JBSWY3DPEHPK3PXP' });
  const verifiedResponse = response('/api/auth/mfa/verify-setup', { accessToken: 'fixture-access-token' });
  const verified = Promise.withResolvers<Response>();
  if (!holdSetup) verified.resolve(browserResponse(verifiedResponse));
  const unrelated: ResponseListener = vi.fn();
  const listeners = new Set<ResponseListener>([unrelated]);
  const verifyButton = { fixtureLocator: true, click: vi.fn(async () => undefined) };
  let responses = 0;
  const pageBoundary = {
    on: vi.fn((_event: 'response', listener: ResponseListener) => {
      listeners.add(listener);
    }),
    off: vi.fn((_event: 'response', listener: ResponseListener) => {
      listeners.delete(listener);
    }),
    waitForResponse: vi.fn((predicate: (value: Response) => boolean) => {
      const next = responses++ === 0 ? otcResponse : verifiedResponse;
      expect(predicate(browserResponse(next))).toBe(true);
      return responses === 1 ? Promise.resolve(browserResponse(otcResponse)) : verified.promise;
    }),
    waitForURL: vi.fn(async (predicate: (value: URL) => boolean) => {
      expect(predicate(new URL('https://fixture.example.test/new'))).toBe(true);
      expect(predicate(new URL('https://fixture.example.test/login'))).toBe(false);
    }),
    getByTestId: (id: string) =>
      id === 'mfa-modal-verify-btn'
        ? verifyButton
        : {
            fixtureLocator: true,
            locator: () => ({ fixtureLocator: true }),
          },
  };
  const loginBoundary = {
    goto: vi.fn(async () => undefined),
    fillEmail: vi.fn(async (_email: string) => undefined),
    fillOtc: vi.fn(async (_code: string) => undefined),
    submitOtcExpectingMfa: vi.fn(async () => {
      // The setup watcher must already exist before submit can produce the setup response.
      expect(listeners.size).toBe(2);
      if (mode === 'setup') {
        await Promise.all([...listeners].map(listener => listener(browserResponse(setupResponse))));
      }
    }),
    expectMfaChallenge: vi.fn(async () => undefined),
    fillMfaCode: vi.fn(async (_code: string) => undefined),
    submitMfa: vi.fn(async () => undefined),
  };
  const page = pageBoundary as unknown as Page;
  const login = loginBoundary as unknown as LoginPage;
  return {
    page,
    login,
    pageBoundary,
    loginBoundary,
    listeners,
    unrelated,
    otcResponse,
    verifiedResponse,
    verified,
    verifyButton,
    body,
  };
}
const expectOnlyUnrelated = (value: ReturnType<typeof fixture>) => {
  expect([...value.listeners]).toEqual([value.unrelated]);
};
beforeEach(() => {
  helpers.otc.mockReset().mockResolvedValue('123456');
  helpers.mfa.mockReset().mockResolvedValue('654321');
  helpers.fillInput.mockReset().mockResolvedValue(undefined);
});

// Real form flow and response watcher; browser, request transport, and locator assertions are doubles.
describe('existing-user MFA response listener ownership', () => {
  it('cleans up repeated enrolled sign-ins without removing another listener', async () => {
    const value = fixture('enrolled');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      value.pageBoundary.waitForResponse.mockResolvedValueOnce(browserResponse(value.otcResponse));
      await expect(signInThroughForm(value.page, value.login, request, EMAIL)).resolves.toEqual(value.body);
      expectOnlyUnrelated(value);
    }
    expect(helpers.otc).toHaveBeenCalledTimes(2);
    expect(helpers.mfa).toHaveBeenCalledTimes(2);
    expect(helpers.otc).toHaveBeenLastCalledWith(request, EMAIL);
    expect(helpers.mfa).toHaveBeenLastCalledWith(request, EMAIL);
    expect(value.loginBoundary.fillMfaCode).toHaveBeenLastCalledWith('654321');
    expect(value.pageBoundary.off).toHaveBeenCalledTimes(2);
  });

  it('cleans up a direct session without requesting a second factor', async () => {
    const value = fixture('direct');
    await signInThroughForm(value.page, value.login, request, EMAIL);
    expectOnlyUnrelated(value);
    expect(helpers.mfa).not.toHaveBeenCalled();
  });

  it('keeps the early setup listener until verification settles, then removes only its own listener', async () => {
    const value = fixture('setup', true);
    const signingIn = signInThroughForm(value.page, value.login, request, EMAIL);
    await vi.waitFor(() => expect(value.verifyButton.click).toHaveBeenCalledOnce());
    expect(value.listeners.size).toBe(2);
    expect(helpers.fillInput).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/^\d{6}$/));
    value.verified.resolve(browserResponse(value.verifiedResponse));
    await signingIn;
    expectOnlyUnrelated(value);
    expect(helpers.mfa).not.toHaveBeenCalled();
  });

  it.each(['goto', 'submit', 'verify-json', 'challenge', 'navigation', 'enrollment'] as const)(
    'preserves the original %s error and releases its listener',
    async stage => {
      const value = fixture(stage === 'enrollment' ? 'setup' : 'enrolled');
      const failure = new Error(`fixture ${stage} failure`);
      if (stage === 'goto') value.loginBoundary.goto.mockRejectedValueOnce(failure);
      if (stage === 'submit') value.loginBoundary.submitOtcExpectingMfa.mockRejectedValueOnce(failure);
      if (stage === 'verify-json') value.otcResponse.json.mockRejectedValueOnce(failure);
      if (stage === 'challenge') value.loginBoundary.expectMfaChallenge.mockRejectedValueOnce(failure);
      if (stage === 'navigation') value.pageBoundary.waitForURL.mockRejectedValueOnce(failure);
      if (stage === 'enrollment') value.verifiedResponse.json.mockRejectedValueOnce(failure);
      await expect(signInThroughForm(value.page, value.login, request, EMAIL)).rejects.toBe(failure);
      expectOnlyUnrelated(value);
    }
  );
});

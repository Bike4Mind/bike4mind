import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import bcrypt from 'bcryptjs';
import type { IAuthSessionStepUpEmailChallenge } from '@bike4mind/common';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  baseApiOptions: [] as unknown[],
  findByIdWithPassword: vi.fn(),
  findByIdWithMfaSecrets: vi.fn(),
  recordFailedAttempt: vi.fn(),
  countPasskeys: vi.fn(),
  verifyMFA: vi.fn(),
  finishPasskeyAuthentication: vi.fn(),
  startPasskeyAuthentication: vi.fn(),
  logAuthAudit: vi.fn(),
  publishEmail: vi.fn(),
  endRealtimeConnections: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    h.baseApiOptions.push(options);
    const chain: Record<string, unknown> = {};
    Object.assign(chain, { use: () => chain, post: (fn: Handler) => fn, get: (fn: Handler) => fn });
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: Handler) => fn }));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: h.logAuthAudit }));
vi.mock('@server/utils/eventBus', () => ({ EmailEvents: { Send: { publish: h.publishEmail } } }));
vi.mock('@server/utils/mailer/emailHelpers', () => ({ buildEmailLogoImg: () => '' }));

/** In-memory AuthSession store with the repository's filter semantics (see AuthSessionModel). */
type FakeSession = {
  sid: string;
  userId: string;
  revokedAt: Date | null;
  expiresAt: Date;
  stepUpAt: Date | null;
  stepUpPasswordFailures?: number;
  stepUpEmailChallenge: IAuthSessionStepUpEmailChallenge | null;
};
const { sessions, authSessionRepository } = vi.hoisted(() => {
  const sessions = new Map<string, FakeSession>();
  const live = (sid: string, userId?: string) => {
    const s = sessions.get(sid);
    if (!s || s.revokedAt || s.expiresAt <= new Date()) return null;
    return userId === undefined || s.userId === userId ? s : null;
  };
  const authSessionRepository = {
    findBySid: async (sid: string) => sessions.get(sid) ?? null,
    markStepUp: async (sid: string, userId: string, at: Date) => {
      const s = live(sid, userId);
      if (!s) return null;
      s.stepUpAt = at;
      return s;
    },
    recordStepUpPasswordFailure: async (sid: string, userId: string) => {
      const s = live(sid, userId);
      if (!s) return null;
      s.stepUpPasswordFailures = (s.stepUpPasswordFailures ?? 0) + 1;
      return s.stepUpPasswordFailures;
    },
    revokeBySid: async (sid: string) => {
      const s = sessions.get(sid);
      if (!s || s.revokedAt) return null;
      s.revokedAt = new Date();
      return s;
    },
    setStepUpEmailChallenge: async (
      sid: string,
      userId: string,
      challenge: Omit<IAuthSessionStepUpEmailChallenge, 'attempts'>
    ) => {
      const s = live(sid, userId);
      if (s) s.stepUpEmailChallenge = { ...challenge, attempts: 0 };
      return !!s;
    },
    findStepUpEmailChallenge: async (sid: string, userId: string) => {
      const c = live(sid, userId)?.stepUpEmailChallenge;
      return c && c.expiresAt > new Date() ? { ...c } : null;
    },
    recordStepUpEmailChallengeFailure: async (sid: string, tokenHash: string) => {
      const s = sessions.get(sid);
      const c = s && !s.revokedAt ? s.stepUpEmailChallenge : null;
      if (!c || c.tokenHash !== tokenHash) return null;
      c.attempts += 1;
      return c.attempts;
    },
    consumeStepUpEmailChallenge: async (
      sid: string,
      userId: string,
      tokenHash: string,
      at: Date,
      maxAttempts: number
    ) => {
      const s = live(sid, userId);
      const c = s?.stepUpEmailChallenge;
      if (!s || !c || c.tokenHash !== tokenHash || c.attempts >= maxAttempts || c.expiresAt <= at) return null;
      s.stepUpEmailChallenge = null;
      s.stepUpAt = at;
      return s;
    },
  };
  return { sessions, authSessionRepository };
});

vi.mock('@bike4mind/database', () => ({
  userRepository: {
    findByIdWithPassword: h.findByIdWithPassword,
    findByIdWithMfaSecrets: h.findByIdWithMfaSecrets,
    atomicRecordMfaFailedAttempt: h.recordFailedAttempt,
  },
  authSessionRepository,
  passkeyCredentialRepository: { countByUser: h.countPasskeys },
  passkeyChallengeRepository: {},
  realtimeConnectionRepository: {},
}));

vi.mock('@bike4mind/services', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/services')>('@bike4mind/services');
  return {
    authSessionService: { endRealtimeConnections: h.endRealtimeConnections },
    userService: {
      sendOTC: actual.userService.sendOTC,
      OTC_EXPIRY_MS: actual.userService.OTC_EXPIRY_MS,
      OTC_CODE_LENGTH: actual.userService.OTC_CODE_LENGTH,
    },
    mfaService: {
      userHasMFAConfigured: (user: { mfa?: { totpEnabled?: boolean } }) => !!user.mfa?.totpEnabled,
      isUserLockedOut: (user: { mfa?: { lockedUntil?: Date } }) =>
        !!user.mfa?.lockedUntil && new Date(user.mfa.lockedUntil) > new Date(),
      getLockoutTimeRemaining: () => 15,
      MAX_FAILED_ATTEMPTS: 3,
      resolvePasskeyRelyingParty: () => ({ rpID: 'app.example.com', rpName: 'Example', origin: 'https://x' }),
      verifyMFA: h.verifyMFA,
      finishPasskeyAuthentication: h.finishPasskeyAuthentication,
      startPasskeyAuthentication: h.startPasskeyAuthentication,
    },
  };
});

import stepUpHandler from '@pages/api/auth/step-up';
import optionsHandler from '@pages/api/auth/step-up/options';
import passkeyOptionsHandler from '@pages/api/auth/step-up/passkey-options';
import emailSendHandler from '@pages/api/auth/step-up/email/send';
import { userService } from '@bike4mind/services';

const PASSWORD_HASH = bcrypt.hashSync('correct horse', 4);
const ENROLLED = { id: 'user-1', email: 'owner@example.com', password: PASSWORD_HASH, mfa: { totpEnabled: true } };
const PLAIN = { id: 'user-1', email: 'owner@example.com', password: PASSWORD_HASH };

const assertion = {
  id: 'cred-a',
  rawId: 'cred-a',
  type: 'public-key',
  clientExtensionResults: {},
  response: { clientDataJSON: 'cdj', authenticatorData: 'ad', signature: 'sig' },
};

const call = async (handler: unknown, { method = 'POST', body = {}, sid = 'sid-1' as string | null } = {}) => {
  const { req, res } = createMocks({ method: method as 'POST', body });
  Object.assign(req, {
    user: { id: 'user-1', sid: sid ?? undefined },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  await (handler as Handler)(req, res);
  return res;
};

const asUser = (user: object) => {
  h.findByIdWithPassword.mockResolvedValue(user);
  h.findByIdWithMfaSecrets.mockResolvedValue(user);
};

/** A rejected proof answers 400 with a code, so the client never treats it as an expired session. */
const expectStepUpFailed = (res: { _getStatusCode: () => number; _getJSONData: () => unknown }) => {
  expect(res._getStatusCode()).toBe(400);
  expect(res._getJSONData()).toMatchObject({ code: 'step_up_failed', error: expect.any(String) });
};

const lastEmailedCode = () => {
  const body: string = h.publishEmail.mock.calls.at(-1)![0].body;
  return body.match(/class="code">(\d+)</)![1];
};

beforeEach(() => {
  vi.clearAllMocks();
  sessions.clear();
  sessions.set('sid-1', {
    sid: 'sid-1',
    userId: 'user-1',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 86_400_000),
    stepUpAt: null,
    stepUpEmailChallenge: null,
  });
  h.countPasskeys.mockResolvedValue(0);
  h.recordFailedAttempt.mockResolvedValue({ id: 'user-1', mfa: { failedAttempts: 1 } });
  asUser(ENROLLED);
});

it('every step-up endpoint accepts a browser session only', () => {
  expect(h.baseApiOptions).toHaveLength(4);
  for (const options of h.baseApiOptions) expect(options).toMatchObject({ auth: 'jwtOnly' });
});

describe('GET /api/auth/step-up/options', () => {
  it('lists the methods for this user and the current window', async () => {
    h.countPasskeys.mockResolvedValue(1);
    let res = await call(optionsHandler, { method: 'GET' });
    expect(res._getJSONData()).toEqual({ methods: ['totp', 'passkey'], stepUpUntil: null });

    sessions.get('sid-1')!.stepUpAt = new Date();
    res = await call(optionsHandler, { method: 'GET' });
    expect(res._getJSONData().stepUpUntil).toEqual(expect.any(String));

    asUser(PLAIN);
    res = await call(optionsHandler, { method: 'GET' });
    expect(res._getJSONData().methods).toEqual(['password', 'email']);
  });
});

describe('POST /api/auth/step-up - totp', () => {
  it('stamps the session on a valid code or backup code', async () => {
    h.verifyMFA.mockResolvedValue({ verified: true, user: ENROLLED });
    const res = await call(stepUpHandler, { body: { method: 'totp', code: '123456' } });

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().stepUpUntil).toEqual(expect.any(String));
    expect(h.verifyMFA.mock.calls[0][0]).toMatchObject({ token: '123456' });
    expect(sessions.get('sid-1')!.stepUpAt).toBeInstanceOf(Date);
    expect(h.logAuthAudit.mock.calls[0][1]).toMatchObject({ event: 'step_up_success', metadata: { method: 'totp' } });
  });

  it('answers a wrong code with 400 step_up_failed, counting it toward the shared MFA lockout', async () => {
    h.verifyMFA.mockRejectedValue(new Error('Invalid TOTP or backup code.'));
    const res = await call(stepUpHandler, { body: { method: 'totp', code: '000000' } });

    expectStepUpFailed(res);
    expect(res._getJSONData()).toMatchObject({ attemptsRemaining: 2 });
    expect(h.recordFailedAttempt).toHaveBeenCalledWith('user-1');
    expect(sessions.get('sid-1')!.stepUpAt).toBeNull();
    expect(h.logAuthAudit.mock.calls[0][1]).toMatchObject({ event: 'step_up_failed' });
  });

  it('locks out when the miss reaches the limit, and refuses a locked-out user up front', async () => {
    h.verifyMFA.mockRejectedValue(new Error('Invalid TOTP or backup code.'));
    h.recordFailedAttempt.mockResolvedValue({ id: 'user-1', mfa: { lockedUntil: new Date(Date.now() + 60_000) } });
    expect((await call(stepUpHandler, { body: { method: 'totp', code: '000000' } }))._getStatusCode()).toBe(423);

    vi.clearAllMocks();
    asUser({ ...ENROLLED, mfa: { totpEnabled: true, lockedUntil: new Date(Date.now() + 60_000) } });
    expect((await call(stepUpHandler, { body: { method: 'totp', code: '123456' } }))._getStatusCode()).toBe(423);
    expect(h.verifyMFA).not.toHaveBeenCalled();
  });

  it('is refused (400) for a user without MFA', async () => {
    asUser(PLAIN);
    const res = await call(stepUpHandler, { body: { method: 'totp', code: '123456' } });
    expect(res._getStatusCode()).toBe(400);
    expect(h.verifyMFA).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/step-up - passkey', () => {
  beforeEach(() => h.countPasskeys.mockResolvedValue(1));
  const passkeyError = (code: string) => Object.assign(new Error(code), { name: 'PasskeyError', code });

  it('stamps the session on a verified assertion', async () => {
    h.finishPasskeyAuthentication.mockResolvedValue({ user: ENROLLED, credentialId: 'pk' });
    const res = await call(stepUpHandler, { body: { method: 'passkey', response: assertion } });
    expect(res._getStatusCode()).toBe(200);
    expect(sessions.get('sid-1')!.stepUpAt).toBeInstanceOf(Date);
  });

  it('counts a rejected assertion (step_up_failed) but not an expired ceremony', async () => {
    h.finishPasskeyAuthentication.mockRejectedValue(passkeyError('verification_failed'));
    expectStepUpFailed(await call(stepUpHandler, { body: { method: 'passkey', response: assertion } }));
    expect(h.recordFailedAttempt).toHaveBeenCalledTimes(1);

    h.finishPasskeyAuthentication.mockRejectedValue(passkeyError('challenge_expired'));
    expect((await call(stepUpHandler, { body: { method: 'passkey', response: assertion } }))._getStatusCode()).toBe(
      400
    );
    expect(h.recordFailedAttempt).toHaveBeenCalledTimes(1);
    expect(sessions.get('sid-1')!.stepUpAt).toBeNull();
  });

  it('is refused (400) when the user has no passkeys', async () => {
    h.countPasskeys.mockResolvedValue(0);
    const res = await call(stepUpHandler, { body: { method: 'passkey', response: assertion } });
    expect(res._getStatusCode()).toBe(400);
  });
});

describe('POST /api/auth/step-up - password', () => {
  beforeEach(() => asUser(PLAIN));

  it('stamps the session on the right password and rejects a wrong one', async () => {
    expectStepUpFailed(await call(stepUpHandler, { body: { method: 'password', password: 'nope' } }));
    expect(sessions.get('sid-1')!.stepUpAt).toBeNull();
    expect(h.logAuthAudit.mock.calls[0][1]).toMatchObject({
      event: 'step_up_failed',
      metadata: { method: 'password' },
    });

    const res = await call(stepUpHandler, { body: { method: 'password', password: 'correct horse' } });
    expect(res._getStatusCode()).toBe(200);
    expect(sessions.get('sid-1')!.stepUpAt).toBeInstanceOf(Date);
  });

  it('revokes the session after too many wrong passwords, even if the next one is right', async () => {
    for (let attempt = 1; attempt < 5; attempt += 1) {
      const res = await call(stepUpHandler, { body: { method: 'password', password: 'nope' } });
      expectStepUpFailed(res);
      expect(res._getJSONData()).toMatchObject({ attemptsRemaining: 5 - attempt });
      expect(sessions.get('sid-1')!.revokedAt).toBeNull();
    }
    expect(h.endRealtimeConnections).not.toHaveBeenCalled();

    const lockedOut = await call(stepUpHandler, { body: { method: 'password', password: 'nope' } });
    expectStepUpFailed(lockedOut);
    expect(lockedOut._getJSONData()).toMatchObject({ attemptsRemaining: 0 });
    expect(sessions.get('sid-1')!.revokedAt).toBeInstanceOf(Date);
    expect(h.endRealtimeConnections).toHaveBeenCalledWith({ sid: 'sid-1' }, expect.anything());

    // A right and a wrong guess get the same answer, so the revoked session learns nothing.
    for (const password of ['correct horse', 'still-wrong']) {
      await expect(call(stepUpHandler, { body: { method: 'password', password } })).rejects.toMatchObject({
        statusCode: 403,
        additionalInfo: { code: 'step_up_unavailable' },
      });
    }
    expect(sessions.get('sid-1')!.stepUpAt).toBeNull();
    expect(sessions.get('sid-1')!.stepUpPasswordFailures).toBe(5);
  });

  it('is refused (400) for an MFA-enrolled user even with the right password', async () => {
    asUser(ENROLLED);
    const res = await call(stepUpHandler, { body: { method: 'password', password: 'correct horse' } });
    expect(res._getStatusCode()).toBe(400);
    expect(sessions.get('sid-1')!.stepUpAt).toBeNull();
  });

  it('answers 403 and logs no success when the session was revoked mid-request', async () => {
    vi.spyOn(authSessionRepository, 'markStepUp').mockResolvedValueOnce(null);

    await expect(
      call(stepUpHandler, { body: { method: 'password', password: 'correct horse' } })
    ).rejects.toMatchObject({ statusCode: 403, additionalInfo: { code: 'step_up_unavailable' } });
    expect(h.logAuthAudit).not.toHaveBeenCalled();
    expect(sessions.get('sid-1')!.stepUpAt).toBeNull();
  });

  it('cannot step up a request that has no session id', async () => {
    await expect(
      call(stepUpHandler, { body: { method: 'password', password: 'correct horse' }, sid: null })
    ).rejects.toMatchObject({ statusCode: 403, additionalInfo: { code: 'step_up_unavailable' } });
  });
});

describe('POST /api/auth/step-up - email', () => {
  beforeEach(() => asUser(PLAIN));

  const send = async (body: object = {}) => {
    const res = await call(emailSendHandler, { body });
    expect(res._getStatusCode()).toBe(200);
    return res._getJSONData().pendingToken as string;
  };

  it("mails the code to the account's current address, never one from the body", async () => {
    await send({ email: 'someone-else@example.com' });
    expect(h.publishEmail).toHaveBeenCalledTimes(1);
    expect(h.publishEmail.mock.calls[0][0].to).toBe('owner@example.com');
  });

  it('stamps the session for the emailed code, once', async () => {
    const pendingToken = await send();
    const code = lastEmailedCode();

    const res = await call(stepUpHandler, { body: { method: 'email', pendingToken, code } });
    expect(res._getStatusCode()).toBe(200);
    expect(sessions.get('sid-1')!.stepUpAt).toBeInstanceOf(Date);

    expectStepUpFailed(await call(stepUpHandler, { body: { method: 'email', pendingToken, code } }));
  });

  it('counts wrong codes and expires the challenge after the limit', async () => {
    const pendingToken = await send();
    const code = lastEmailedCode();
    const wrong = code === '00000000' ? '11111111' : '00000000';

    const first = await call(stepUpHandler, { body: { method: 'email', pendingToken, code: wrong } });
    expectStepUpFailed(first);
    expect(first._getJSONData().attemptsRemaining).toBe(4);
    for (let i = 0; i < 4; i += 1) await call(stepUpHandler, { body: { method: 'email', pendingToken, code: wrong } });

    const late = await call(stepUpHandler, { body: { method: 'email', pendingToken, code } });
    expectStepUpFailed(late);
    expect(late._getJSONData().attemptsRemaining).toBe(0);
    expect(sessions.get('sid-1')!.stepUpAt).toBeNull();
  });

  it('never accepts a sign-in code, and a step-up code only with its own token', async () => {
    let loginCode = '';
    const login = await userService.sendOTC(
      { email: 'owner@example.com' },
      {
        mailer: { sendOTCEmail: async (_to, code) => void (loginCode = code) },
        signPendingToken: payload => `login.${payload.jti}`,
      }
    );
    const stepUpToken = await send();

    const withLoginToken = await call(stepUpHandler, {
      body: { method: 'email', pendingToken: login.pendingToken, code: loginCode },
    });
    expectStepUpFailed(withLoginToken);
    // Independent random 8-digit codes: a collision is a 1e-8 event.
    const loginCodeWithStepUpToken = await call(stepUpHandler, {
      body: { method: 'email', pendingToken: stepUpToken, code: loginCode },
    });
    expectStepUpFailed(loginCodeWithStepUpToken);
    expect(sessions.get('sid-1')!.stepUpAt).toBeNull();
  });

  it('binds the challenge to the session that requested it', async () => {
    const pendingToken = await send();
    const code = lastEmailedCode();
    sessions.set('sid-2', { ...sessions.get('sid-1')!, sid: 'sid-2', stepUpEmailChallenge: null });

    const res = await call(stepUpHandler, { body: { method: 'email', pendingToken, code }, sid: 'sid-2' });
    expectStepUpFailed(res);
    expect(sessions.get('sid-2')!.stepUpAt).toBeNull();
  });

  it('sends nothing when the challenge cannot be stored on the session', async () => {
    vi.spyOn(authSessionRepository, 'setStepUpEmailChallenge').mockResolvedValueOnce(false);
    await expect(call(emailSendHandler)).rejects.toMatchObject({ statusCode: 403 });
    expect(h.publishEmail).not.toHaveBeenCalled();
  });

  it('sends nothing to a request that has no session id', async () => {
    await expect(call(emailSendHandler, { sid: null })).rejects.toMatchObject({
      statusCode: 403,
      additionalInfo: { code: 'step_up_unavailable' },
    });
    expect(h.publishEmail).not.toHaveBeenCalled();
  });

  it('is refused (400) for an MFA-enrolled user', async () => {
    asUser(ENROLLED);
    expect((await call(emailSendHandler))._getStatusCode()).toBe(400);
    expect(h.publishEmail).not.toHaveBeenCalled();
    const res = await call(stepUpHandler, { body: { method: 'email', pendingToken: 'x', code: '12345678' } });
    expect(res._getStatusCode()).toBe(400);
  });
});

describe('POST /api/auth/step-up/passkey-options', () => {
  it('issues request options for a user with passkeys and refuses one without', async () => {
    h.countPasskeys.mockResolvedValue(1);
    h.startPasskeyAuthentication.mockResolvedValue({ challenge: 'c' });
    const res = await call(passkeyOptionsHandler);
    expect(res._getJSONData()).toEqual({ challenge: 'c' });
    expect(h.startPasskeyAuthentication.mock.calls[0][0]).toMatchObject({ userId: 'user-1' });

    h.countPasskeys.mockResolvedValue(0);
    expect((await call(passkeyOptionsHandler))._getStatusCode()).toBe(400);
  });
});

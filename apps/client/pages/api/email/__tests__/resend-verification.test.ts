import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;
type Adapters = {
  mailer: { sendEmailVerificationEmail: (user: { username: string; email: string }, token: string) => Promise<void> };
};

const { mockStatus, mockPublish, mockResend } = vi.hoisted(() => ({
  mockStatus: vi.fn(),
  mockPublish: vi.fn(async () => undefined),
  mockResend: vi.fn(),
}));

// Middleware is stripped so the handler body runs directly, as in verify.test.ts.
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: Handler) => fn }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    interface Chain {
      use: () => Chain;
      post: (fn: Handler) => Handler;
    }
    const chain: Chain = { use: () => chain, post: fn => fn };
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next?: () => void) => next?.(),
}));
vi.mock('@bike4mind/server-utils/utils/mailer/sender', () => ({ loadMailConfigStatus: mockStatus }));
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({ EmailEvents: { Send: { publish: mockPublish } } }));
vi.mock('@bike4mind/server-utils/utils/auditLog', () => ({
  logAuditEvent: vi.fn(),
  EmailAuditEvents: { EMAIL_VERIFICATION_RESENT: 'resent' },
}));
vi.mock('@bike4mind/server-utils/utils/mailer/emailHelpers', () => ({
  generateVerificationLink: (token: string) => `https://app.example.com/verify?token=${token}`,
  getLogoUrl: () => '',
  buildEmailLogoImg: () => '',
  escapeHtml: (value: string) => value,
}));
vi.mock('@bike4mind/database', async () => ({
  userRepository: {},
  ...(await import('@server/utils/__tests__/fakeTransaction')),
}));
vi.mock('@bike4mind/services', () => ({ userService: { resendEmailVerification: mockResend } }));

import { fakeTransaction } from '@server/utils/__tests__/fakeTransaction';
import handler from '../resend-verification';

function invoke(isAdmin: boolean) {
  const { req, res } = createMocks({ method: 'POST' });
  Object.assign(req, { user: { id: 'user-1', isAdmin }, ip: '127.0.0.1', logger: {} });
  return { req, res, done: (handler as unknown as Handler)(req, res) };
}

describe('POST /api/email/resend-verification', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    fakeTransaction.reset();
    mockResend.mockImplementation(async (_params: unknown, adapters: Adapters) => {
      await adapters.mailer.sendEmailVerificationEmail({ username: 'ada', email: 'ada@example.com' }, 'tok');
    });
  });

  it('tells an admin which secrets are missing and sends nothing when mail is not configured', async () => {
    mockStatus.mockReturnValue({
      configured: false,
      transport: 'smtp',
      missingSecrets: ['MAIL_HOST'],
      optionalSecrets: [],
      secrets: {},
    });
    const { res, done } = invoke(true);
    await done;

    expect(res._getStatusCode()).toBe(503);
    expect(res._getJSONData()).toMatchObject({ isConfigError: true, missingSecrets: ['MAIL_HOST'] });
    expect(mockResend).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('points a self-host admin at the env file and chart instead of SST secrets', async () => {
    vi.stubEnv('B4M_SELF_HOST', 'true');
    mockStatus.mockReturnValue({
      configured: false,
      transport: 'smtp',
      missingSecrets: ['MAIL_HOST'],
      optionalSecrets: [],
      secrets: {},
    });
    const { res, done } = invoke(true);
    await done;

    const { message } = res._getJSONData();
    expect(message).toContain('.env.selfhost');
    expect(message).not.toContain('SST secrets');
  });

  it('keeps the SST hint off self-host', async () => {
    vi.stubEnv('B4M_SELF_HOST', '');
    mockStatus.mockReturnValue({
      configured: false,
      transport: 'smtp',
      missingSecrets: ['MAIL_HOST'],
      optionalSecrets: [],
      secrets: {},
    });
    const { res, done } = invoke(true);
    await done;

    expect(res._getJSONData().message).toContain('Configure these in your SST secrets.');
  });

  it('gives a non-admin a generic 503 without the secret names', async () => {
    mockStatus.mockReturnValue({
      configured: false,
      transport: 'smtp',
      missingSecrets: ['MAIL_HOST'],
      optionalSecrets: [],
      secrets: {},
    });
    const { res, done } = invoke(false);
    await done;

    expect(res._getStatusCode()).toBe(503);
    expect(res._getJSONData().missingSecrets).toBeUndefined();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('publishes the verification email when the status reports mail as configured', async () => {
    mockStatus.mockReturnValue({
      configured: true,
      transport: 'ses',
      missingSecrets: [],
      optionalSecrets: [],
      secrets: { MAIL_FROM: true },
    });
    const { res, done } = invoke(false);
    await done;

    expect(res._getStatusCode()).toBe(200);
    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'ada@example.com', subject: 'Verify Your Email Address' })
    );
  });

  describe('when mail is configured', () => {
    beforeEach(() => {
      mockStatus.mockReturnValue({
        configured: true,
        transport: 'ses',
        missingSecrets: [],
        optionalSecrets: [],
        secrets: { MAIL_FROM: true },
      });
    });

    it('publishes once when the transaction callback is retried', async () => {
      fakeTransaction.outcome = 'retryOnce';
      const { res, done } = invoke(false);
      await done;

      expect(fakeTransaction.runs).toBe(2);
      expect(mockResend).toHaveBeenCalledTimes(2);
      expect(mockPublish).toHaveBeenCalledTimes(1);
      expect(res._getStatusCode()).toBe(200);
    });

    it('publishes nothing and sends no success response when the transaction aborts', async () => {
      fakeTransaction.outcome = 'abort';
      const { res, done } = invoke(false);

      await expect(done).rejects.toThrow('Transaction aborted');
      expect(mockPublish).not.toHaveBeenCalled();
      expect(res._isEndCalled()).toBe(false);
    });

    it('publishes only after the transaction callback has finished', async () => {
      let callbackDone = false;
      mockResend.mockImplementation(async (_params: unknown, adapters: Adapters) => {
        await adapters.mailer.sendEmailVerificationEmail({ username: 'ada', email: 'ada@example.com' }, 'tok');
        expect(mockPublish).not.toHaveBeenCalled();
        callbackDone = true;
      });
      mockPublish.mockImplementation(async () => {
        expect(callbackDone).toBe(true);
      });
      const { done } = invoke(false);
      await done;

      expect(mockPublish).toHaveBeenCalledTimes(1);
    });

    it('fails the request when the publish after commit fails', async () => {
      mockPublish.mockRejectedValueOnce(new Error('bus down'));
      const { res, done } = invoke(false);

      await expect(done).rejects.toThrow('bus down');
      expect(res._isEndCalled()).toBe(false);
    });
  });
});

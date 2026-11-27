import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;
type Adapters = {
  mailer: { sendEmailVerificationEmail: (user: { username: string; email: string }, token: string) => Promise<void> };
};

const { mockPublish, mockSend, mockAudit } = vi.hoisted(() => ({
  mockPublish: vi.fn(),
  mockSend: vi.fn(),
  mockAudit: vi.fn(),
}));

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
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({ EmailEvents: { Send: { publish: mockPublish } } }));
vi.mock('@bike4mind/server-utils/utils/auditLog', () => ({
  logAuditEvent: mockAudit,
  EmailAuditEvents: { EMAIL_VERIFICATION_SENT: 'sent' },
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
vi.mock('@bike4mind/services', () => ({ userService: { sendEmailVerification: mockSend } }));

import { fakeTransaction } from '@server/utils/__tests__/fakeTransaction';
import handler from '../send-verification';

function invoke() {
  const { req, res } = createMocks({ method: 'POST' });
  Object.assign(req, { user: { id: 'user-1' }, ip: '127.0.0.1', logger: {} });
  return { res, done: (handler as unknown as Handler)(req, res) };
}

describe('POST /api/email/send-verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeTransaction.reset();
    mockPublish.mockResolvedValue(undefined);
    mockSend.mockImplementation(async (_params: unknown, adapters: Adapters) => {
      await adapters.mailer.sendEmailVerificationEmail({ username: 'ada', email: 'ada@example.com' }, 'tok');
    });
  });

  it('publishes the email with the token link, audits, and responds after the commit', async () => {
    const { res, done } = invoke();
    await done;

    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'ada@example.com',
        subject: 'Verify Your Email Address',
        body: expect.stringContaining('https://app.example.com/verify?token=tok'),
      })
    );
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'sent', userId: 'user-1' }), {});
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ message: 'Verification email sent successfully' });
  });

  it('publishes once when the transaction callback is retried', async () => {
    fakeTransaction.outcome = 'retryOnce';
    const { res, done } = invoke();
    await done;

    expect(fakeTransaction.runs).toBe(2);
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(res._getStatusCode()).toBe(200);
  });

  it('publishes nothing and sends no success response when the transaction aborts', async () => {
    fakeTransaction.outcome = 'abort';
    const { res, done } = invoke();

    await expect(done).rejects.toThrow('Transaction aborted');
    expect(mockPublish).not.toHaveBeenCalled();
    expect(res._isEndCalled()).toBe(false);
  });

  it('fails the request when the publish after commit fails', async () => {
    mockPublish.mockRejectedValueOnce(new Error('bus down'));
    const { res, done } = invoke();

    await expect(done).rejects.toThrow('bus down');
    expect(res._isEndCalled()).toBe(false);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { Request, Response } from 'express';

type Handler = (req: Request, res: Response) => unknown;
type Chain = Record<'use' | 'get' | 'put' | 'delete' | 'post', (fn?: Handler) => Chain>;

const mockRefs = vi.hoisted(() => ({
  postHandler: null as null | ((req: Request, res: Response) => unknown),
  baseApiOptions: undefined as unknown,
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: Chain = {
    use: () => chain,
    get: () => chain,
    put: () => chain,
    delete: () => chain,
    post: fn => {
      mockRefs.postHandler = fn ?? null;
      return chain;
    },
  };
  return {
    baseApi: (options?: unknown) => {
      mockRefs.baseApiOptions = options;
      return chain;
    },
  };
});

const transferOwnership = vi.hoisted(() => vi.fn());
const customersUpdate = vi.hoisted(() => vi.fn());
const tx = vi.hoisted(() => ({ active: false }));
const withTransaction = vi.hoisted(() =>
  vi.fn(async (fn: () => unknown) => {
    tx.active = true;
    try {
      return await fn();
    } finally {
      tx.active = false;
    }
  })
);
vi.mock('@bike4mind/services', () => ({ organizationService: { transferOwnership } }));
const findUserById = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: findUserById },
  withTransaction,
}));
const sendOwnershipTransferEmails = vi.hoisted(() => vi.fn());
vi.mock('@server/utils/mailer/ownershipTransferEmail', () => ({ sendOwnershipTransferEmails }));
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: {} }));
vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({
  stripe: { customers: { update: customersUpdate } },
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
  recordAdminActionFromRequest: vi.fn().mockResolvedValue(null),
}));

import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import '@pages/api/organizations/[id]/transfer-ownership';

const baseResult = {
  organizationId: 'org1',
  organizationName: 'Acme',
  previousOwnerId: 'owner1',
  newOwnerId: 'admin1',
  billingContactChanged: true,
  billingContact: 'admin@example.com',
  stripeCustomerId: 'cus_1',
};

const post = (body: unknown = { newOwnerId: 'admin1' }) => {
  const mocks = createMocks<Request, Response>({ method: 'POST', query: { id: 'org1' }, body: body as object });
  const req = Object.assign(mocks.req, {
    user: { id: 'owner1', isAdmin: false },
    logger: { warn: vi.fn() },
  });
  const res = mocks.res;
  return { req, res, run: () => mockRefs.postHandler!(req, res) };
};

describe('POST /api/organizations/[id]/transfer-ownership', () => {
  beforeEach(() => {
    vi.stubEnv('APP_URL', 'https://app.example.com');
    vi.clearAllMocks();
    transferOwnership.mockResolvedValue(baseResult);
    customersUpdate.mockResolvedValue({});
    findUserById.mockImplementation(async (id: string) => ({
      id,
      email: `${id}@example.com`,
      name: id === 'owner1' ? 'Olivia Owner' : 'Adam Admin',
    }));
    sendOwnershipTransferEmails.mockResolvedValue(undefined);
  });

  it('refuses API keys: a key of any scope must not be able to hand off billing ownership', () => {
    expect(mockRefs.baseApiOptions).toEqual({ auth: 'jwtOnly' });
  });

  it('transfers, mirrors the changed billing contact to Stripe, and audits it', async () => {
    const { res, run } = post();
    await run();

    expect(transferOwnership).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'owner1' }),
      { organizationId: 'org1', newOwnerId: 'admin1' },
      expect.anything()
    );
    expect(customersUpdate).toHaveBeenCalledWith('cus_1', { email: 'admin@example.com' });
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'org.owner.transferred',
        target: { kind: 'organization', id: 'org1', displayName: 'Acme' },
        changes: [{ field: 'userId', before: 'owner1', after: 'admin1' }],
      })
    );
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ organizationId: 'org1', ownerId: 'admin1' });
  });

  it('runs the transfer and the audit write in one transaction and the Stripe mirror after it', async () => {
    const inTx = { service: false, audit: false, stripe: false };
    transferOwnership.mockImplementation(async () => {
      inTx.service = tx.active;
      return baseResult;
    });
    vi.mocked(recordAdminActionFromRequest).mockImplementation(async () => {
      inTx.audit = tx.active;
      return null;
    });
    customersUpdate.mockImplementation(async () => {
      inTx.stripe = tx.active;
      return {};
    });

    await post().run();

    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(inTx).toEqual({ service: true, audit: true, stripe: false });
  });

  it('does not touch Stripe when the billing contact did not change', async () => {
    transferOwnership.mockResolvedValue({ ...baseResult, billingContactChanged: false });
    await post().run();
    expect(customersUpdate).not.toHaveBeenCalled();
  });

  it('does not touch Stripe when the org has no customer', async () => {
    transferOwnership.mockResolvedValue({ ...baseResult, stripeCustomerId: null });
    await post().run();
    expect(customersUpdate).not.toHaveBeenCalled();
  });

  it('still succeeds when the Stripe mirror fails, and logs a warning', async () => {
    customersUpdate.mockRejectedValue(new Error('stripe down'));
    const { req, res, run } = post();
    await run();

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ organizationId: 'org1', ownerId: 'admin1' });
    expect(req.logger.warn).toHaveBeenCalledOnce();
    expect(req.logger.warn).toHaveBeenCalledWith(expect.any(String), { error: 'stripe down' });
    expect(recordAdminActionFromRequest).toHaveBeenCalled();
  });

  it('logs a non-Error Stripe rejection as a string and still succeeds', async () => {
    customersUpdate.mockRejectedValue('plain rejection');
    const { req, res, run } = post();
    await run();

    expect(res._getStatusCode()).toBe(200);
    expect(req.logger.warn).toHaveBeenCalledWith(expect.any(String), { error: 'plain rejection' });
  });

  it('fails the request and skips the Stripe mirror when the audit write fails', async () => {
    vi.mocked(recordAdminActionFromRequest).mockRejectedValueOnce(new Error('audit down'));
    await expect(post().run()).rejects.toThrow('audit down');
    expect(customersUpdate).not.toHaveBeenCalled();
  });

  it('rejects a body without newOwnerId before calling the service', async () => {
    await expect(post({}).run()).rejects.toThrow();
    expect(transferOwnership).not.toHaveBeenCalled();
  });

  it('propagates a service refusal and writes no audit row or Stripe update', async () => {
    transferOwnership.mockRejectedValue(new Error('refused'));
    await expect(post().run()).rejects.toThrow('refused');
    expect(customersUpdate).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('emails both parties after the transaction commits', async () => {
    let sentInTx: boolean | null = null;
    sendOwnershipTransferEmails.mockImplementation(async () => {
      sentInTx = tx.active;
    });
    await post().run();

    expect(sentInTx).toBe(false);
    expect(sendOwnershipTransferEmails).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationName: 'Acme',
        organizationUrl: 'https://app.example.com/organizations/org1',
        previousOwner: { email: 'owner1@example.com', name: 'Olivia Owner' },
        newOwner: { email: 'admin1@example.com', name: 'Adam Admin' },
      }),
      expect.anything()
    );
  });

  it('still succeeds when notifying the parties fails, and logs a warning', async () => {
    findUserById.mockRejectedValue(new Error('db down'));
    const { req, res, run } = post();
    await run();

    expect(res._getStatusCode()).toBe(200);
    expect(req.logger.warn).toHaveBeenCalledWith(expect.stringContaining('notify'), { error: 'db down' });
  });

  it('sends no email when the transfer is refused', async () => {
    transferOwnership.mockRejectedValue(new Error('refused'));
    await expect(post().run()).rejects.toThrow('refused');
    expect(sendOwnershipTransferEmails).not.toHaveBeenCalled();
  });
});

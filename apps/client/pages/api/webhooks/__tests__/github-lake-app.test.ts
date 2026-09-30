import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';

const h = vi.hoisted(() => ({
  webhookSecret: 'test-webhook-secret',
  findByInstallationId: vi.fn(),
  sendToQueue: vi.fn(),
  baseApiOptions: [] as unknown[],
  capturedHandler: null as ((req: NextApiRequest, res: NextApiResponse) => Promise<void>) | null,
}));

// Capture the POST handler baseApi({ auth: false }).post(handler) registers, so it can be invoked
// directly without the Next/next-connect stack. Mirrors stripe/webhook and purgeConnectionIngestedFiles.test.ts.
// Lives on the vi.hoisted object (not a plain `let`) because vi.mock factories run before top-level
// `let`/`const` statements execute, so a plain module-scoped variable would still be in its TDZ.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: vi.fn((options: unknown) => {
    h.baseApiOptions.push(options);
    return {
      post: vi.fn().mockImplementation((handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void>) => {
        h.capturedHandler = handler;
        return handler;
      }),
    };
  }),
}));

vi.mock('@server/utils/config', () => ({
  Config: {
    get GITHUB_LAKE_APP_WEBHOOK_SECRET() {
      return h.webhookSecret;
    },
  },
}));
vi.mock('@bike4mind/database', () => ({
  orgGitHubLakeConnectionRepository: { findByInstallationId: h.findByInstallationId },
}));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: h.sendToQueue }));
vi.mock('sst', () => ({ Resource: { githubLakeRevokeQueue: { url: 'https://sqs.test/githubLakeRevokeQueue' } } }));

import handler from '../github-lake-app';

const sign = (secret: string, body: string) =>
  `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

const makeReq = (body: string, headers: Record<string, string> = {}) =>
  ({
    method: 'POST',
    headers,
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), updateMetadata: vi.fn() },
    on(event: string, cb: (arg?: unknown) => void) {
      if (event === 'data') cb(Buffer.from(body));
      if (event === 'end') cb();
    },
  }) as unknown as NextApiRequest & { logger: Record<string, ReturnType<typeof vi.fn>> };

const makeRes = () => {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { res: { status, json } as unknown as NextApiResponse, status, json };
};

const post = (payload: unknown, event: string, secret = h.webhookSecret, extraHeaders: Record<string, string> = {}) => {
  const body = JSON.stringify(payload);
  const req = makeReq(body, {
    'x-github-event': event,
    'x-github-delivery': 'delivery-1',
    'x-hub-signature-256': sign(secret, body),
    ...extraHeaders,
  });
  const { res, status, json } = makeRes();
  const run = (handler as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<void>)(req, res);
  return { run, req, res, status, json };
};

describe('/api/webhooks/github-lake-app', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.webhookSecret = 'test-webhook-secret';
    h.findByInstallationId.mockResolvedValue([]);
    h.sendToQueue.mockResolvedValue(undefined);
    expect(h.capturedHandler).toBeTruthy();
  });

  it('is registered unauthenticated, since GitHub signs the delivery instead of sending a session', () => {
    expect(h.baseApiOptions).toEqual([{ auth: false }]);
  });

  it('503s and processes nothing when the webhook secret is not configured', async () => {
    h.webhookSecret = 'not-configured';
    const { run, status } = post({ action: 'deleted', installation: { id: 1 } }, 'installation');
    await run;
    expect(status).toHaveBeenCalledWith(503);
    expect(h.findByInstallationId).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('401s on a missing or invalid signature', async () => {
    const body = JSON.stringify({ action: 'deleted', installation: { id: 1 } });
    const req = makeReq(body, { 'x-github-event': 'installation', 'x-hub-signature-256': 'sha256=deadbeef' });
    const { res, status } = makeRes();
    await (handler as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<void>)(req, res);
    expect(status).toHaveBeenCalledWith(401);
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('enqueues every connection bound to the installation on installation.deleted', async () => {
    h.findByInstallationId.mockResolvedValue([
      { id: 'conn1', repositoryId: 100 },
      { id: 'conn2', repositoryId: 200 },
    ]);
    const { run, status, json } = post({ action: 'deleted', installation: { id: 42 } }, 'installation');
    await run;
    expect(h.findByInstallationId).toHaveBeenCalledWith(42);
    expect(h.sendToQueue).toHaveBeenCalledWith('https://sqs.test/githubLakeRevokeQueue', { connectionId: 'conn1' });
    expect(h.sendToQueue).toHaveBeenCalledWith('https://sqs.test/githubLakeRevokeQueue', { connectionId: 'conn2' });
    expect(status).toHaveBeenCalledWith(202);
    expect(json).toHaveBeenCalledWith({ queued: 2 });
  });

  it('enqueues only the removed repositories on installation_repositories.removed', async () => {
    h.findByInstallationId.mockResolvedValue([
      { id: 'conn1', repositoryId: 100 },
      { id: 'conn2', repositoryId: 200 },
    ]);
    const { run, status, json } = post(
      { action: 'removed', installation: { id: 42 }, repositories_removed: [{ id: 100 }] },
      'installation_repositories'
    );
    await run;
    expect(h.sendToQueue).toHaveBeenCalledTimes(1);
    expect(h.sendToQueue).toHaveBeenCalledWith('https://sqs.test/githubLakeRevokeQueue', { connectionId: 'conn1' });
    expect(status).toHaveBeenCalledWith(202);
    expect(json).toHaveBeenCalledWith({ queued: 1 });
  });

  it('ignores installation_repositories.added with a 200, touching no repository', async () => {
    const { run, status, json } = post(
      { action: 'added', installation: { id: 42 }, repositories_added: [{ id: 100 }] },
      'installation_repositories'
    );
    await run;
    expect(h.findByInstallationId).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ ignored: true });
  });

  it('ignores an unrelated event type with a 200', async () => {
    const { run, status, json } = post({ some: 'payload' }, 'push');
    await run;
    expect(h.sendToQueue).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ ignored: true });
  });

  it('ignores installation.suspend with a 200 (reversible, not a revoke)', async () => {
    const { run, status, json } = post({ action: 'suspend', installation: { id: 42 } }, 'installation');
    await run;
    expect(h.findByInstallationId).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ ignored: true });
  });

  it('400s a malformed payload for a handled event', async () => {
    const { run, status } = post({ action: 'deleted' }, 'installation');
    await run;
    expect(status).toHaveBeenCalledWith(400);
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('400s a removed delivery that names no repository, rather than acknowledging it as queued: 0', async () => {
    const { run, status } = post(
      { action: 'removed', installation: { id: 42 }, repositories_removed: [] },
      'installation_repositories'
    );
    await run;
    expect(status).toHaveBeenCalledWith(400);
    expect(h.findByInstallationId).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('400s a correctly signed body that is not JSON', async () => {
    const body = '{not json';
    const req = makeReq(body, { 'x-github-event': 'installation', 'x-hub-signature-256': sign(h.webhookSecret, body) });
    const { res, status, json } = makeRes();
    await (handler as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<void>)(req, res);
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: 'Invalid JSON payload' });
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('413s a body over the size cap before checking its signature', async () => {
    const body = 'x'.repeat(1024 * 1024 + 1);
    const req = makeReq(body, { 'x-github-event': 'installation', 'x-hub-signature-256': sign(h.webhookSecret, body) });
    const { res, status } = makeRes();
    await (handler as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<void>)(req, res);
    expect(status).toHaveBeenCalledWith(413);
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('lets an enqueue failure throw, so the delivery reports failed and can be redelivered', async () => {
    h.findByInstallationId.mockResolvedValue([{ id: 'conn1', repositoryId: 100 }]);
    h.sendToQueue.mockRejectedValue(new Error('sqs down'));
    const { run } = post({ action: 'deleted', installation: { id: 42 } }, 'installation');
    await expect(run).rejects.toThrow('sqs down');
  });
});

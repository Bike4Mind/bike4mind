import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';

const h = vi.hoisted(() => ({
  config: {} as Record<string, string | undefined>,
  connectDB: vi.fn(),
  findByInstallationId: vi.fn(),
  recordLastError: vi.fn(),
  sendToQueue: vi.fn(),
}));

vi.mock('@server/utils/config', () => ({
  Config: new Proxy({}, { get: (_target, key: string) => h.config[key] }),
}));

vi.mock('@bike4mind/database', () => ({
  connectDB: h.connectDB,
  orgGitHubLakeConnectionRepository: {
    findByInstallationId: h.findByInstallationId,
    recordLastError: h.recordLastError,
  },
}));

vi.mock('@server/utils/sqs', () => ({ sendToQueue: h.sendToQueue }));

vi.mock('@bike4mind/observability', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    Logger: vi.fn(function () {
      return logger;
    }),
  };
});

vi.mock('@server/integrations/integrationAuditLogger', () => ({
  IntegrationAuditLogger: {
    create: vi.fn(() => ({ failure: vi.fn(), success: vi.fn(), setUserId: vi.fn() })),
  },
}));

const handler = (await import('../lake')).default;

const SECRET = 'lake-app-webhook-secret';
const INSTALLATION_ID = 42;
const REPOSITORY_ID = 1001;

const connection = { id: 'conn1', installationId: INSTALLATION_ID, repositoryId: REPOSITORY_ID, enabled: true };

function pushPayload(overrides: Record<string, unknown> = {}) {
  return {
    ref: 'refs/heads/main',
    deleted: false,
    repository: { id: REPOSITORY_ID, default_branch: 'main', full_name: 'acme/docs' },
    installation: { id: INSTALLATION_ID },
    ...overrides,
  };
}

const sign = (rawBody: string, secret: string = SECRET) =>
  'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

type Delivery = {
  body?: unknown;
  rawBody?: string;
  event?: string | null;
  method?: string;
  signature?: string | null;
  reqError?: Error;
};

// Register-then-emit, as in server/integrations/jira/webhookUtils.test.ts: getRawBody registers its
// 'data'/'end'/'error' listeners synchronously, so the emit has to happen on a later tick.
async function deliver({
  body = pushPayload(),
  rawBody,
  event = 'push',
  method = 'POST',
  signature,
  reqError,
}: Delivery = {}) {
  const resolvedRawBody = rawBody ?? JSON.stringify(body);
  const headers: Record<string, string> = { 'x-github-delivery': 'delivery-1' };
  if (event !== null) headers['x-github-event'] = event;
  const resolvedSignature = signature === undefined ? sign(resolvedRawBody) : signature;
  if (resolvedSignature !== null) headers['x-hub-signature-256'] = resolvedSignature;

  const listeners: Record<string, Array<(data?: Buffer | Error) => void>> = {};
  const req = {
    method,
    headers,
    on: (name: 'data' | 'end' | 'error', callback: (data?: Buffer | Error) => void) => {
      (listeners[name] ??= []).push(callback);
    },
  } as unknown as NextApiRequest;

  setTimeout(() => {
    if (reqError) {
      listeners.error?.forEach(cb => cb(reqError));
      return;
    }
    listeners.data?.forEach(cb => cb(Buffer.from(resolvedRawBody)));
    listeners.end?.forEach(cb => cb());
  }, 0);

  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as NextApiResponse;

  await handler(req, res);
  return { status: vi.mocked(res.status).mock.calls[0]?.[0], json: vi.mocked(res.json).mock.calls[0]?.[0] };
}

describe('POST /api/webhooks/github/lake', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.config = {
      GITHUB_LAKE_APP_WEBHOOK_SECRET: SECRET,
      MONGODB_URI: 'mongodb://localhost:27017/%STAGE%',
      STAGE: 'test',
    };
    h.findByInstallationId.mockResolvedValue([connection]);
    h.sendToQueue.mockResolvedValue(undefined);
    h.recordLastError.mockResolvedValue(undefined);
  });

  it('queues exactly one non-manual re-sync for a signed push to the default branch', async () => {
    const { status, json } = await deliver();

    expect(status).toBe(202);
    expect(json).toEqual({ status: 'queued', connectionId: 'conn1' });
    expect(h.connectDB).toHaveBeenCalledTimes(1);
    expect(h.findByInstallationId).toHaveBeenCalledWith(INSTALLATION_ID);
    expect(h.sendToQueue).toHaveBeenCalledTimes(1);
    expect(h.sendToQueue).toHaveBeenCalledWith('https://sqs.test/githubLakeIngestQueue', {
      connectionId: 'conn1',
      manual: false,
    });
  });

  it('rejects an unsigned push without touching the database or the queue', async () => {
    const { status } = await deliver({ signature: null });

    expect(status).toBe(401);
    expect(h.connectDB).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('rejects a push signed with a different secret', async () => {
    const rawBody = JSON.stringify(pushPayload());
    const { status } = await deliver({ signature: sign(rawBody, 'someone-elses-secret') });

    expect(status).toBe(401);
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('refuses every delivery while the webhook secret is unprovisioned', async () => {
    h.config.GITHUB_LAKE_APP_WEBHOOK_SECRET = 'not-configured';
    const { status } = await deliver({ signature: sign(JSON.stringify(pushPayload()), 'not-configured') });

    expect(status).toBe(503);
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('ignores a push to a branch other than the default', async () => {
    const { status, json } = await deliver({ body: pushPayload({ ref: 'refs/heads/feature/x' }) });

    expect(status).toBe(200);
    expect(json).toMatchObject({ status: 'ignored' });
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('ignores a tag push whose name matches the default branch', async () => {
    const { status } = await deliver({ body: pushPayload({ ref: 'refs/tags/main' }) });

    expect(status).toBe(200);
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('ignores a deletion of the default branch', async () => {
    const { status } = await deliver({ body: pushPayload({ deleted: true }) });

    expect(status).toBe(200);
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('acknowledges a signed non-push event without queueing', async () => {
    const { status, json } = await deliver({ event: 'ping', body: { zen: 'Keep it logically awesome.' } });

    expect(status).toBe(200);
    expect(json).toMatchObject({ status: 'ignored' });
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('ignores a push for a repository no lake is connected to', async () => {
    h.findByInstallationId.mockResolvedValue([{ ...connection, repositoryId: 9999 }]);
    const { status } = await deliver();

    expect(status).toBe(200);
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('ignores a push for a disabled connection', async () => {
    h.findByInstallationId.mockResolvedValue([{ ...connection, enabled: false }]);
    const { status } = await deliver();

    expect(status).toBe(200);
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('rejects a signed push payload with no installation', async () => {
    // A plain repo webhook (not the App) carries no installation.
    const { status } = await deliver({ body: pushPayload({ installation: undefined }) });

    expect(status).toBe(400);
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('records the failure on the connection when the enqueue fails', async () => {
    h.sendToQueue.mockRejectedValue(new Error('SQS down'));
    const { status } = await deliver();

    expect(status).toBe(500);
    expect(h.recordLastError).toHaveBeenCalledWith('conn1', expect.any(String));
  });

  it('only accepts POST', async () => {
    const { status } = await deliver({ method: 'GET' });

    expect(status).toBe(405);
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('rejects a payload over the size limit before verifying the signature', async () => {
    const { status, json } = await deliver({ rawBody: 'x'.repeat(1024 * 1024 + 1), signature: null });

    expect(status).toBe(413);
    expect(json).toEqual({ message: 'Payload too large' });
    expect(h.connectDB).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('rejects a signed body that is not valid JSON', async () => {
    const raw = '{not json';
    const { status, json } = await deliver({ rawBody: raw, signature: sign(raw) });

    expect(status).toBe(400);
    expect(json).toEqual({ message: 'Body is not JSON' });
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('returns 400 when the request body cannot be read', async () => {
    const { status, json } = await deliver({ reqError: new Error('socket reset') });

    expect(status).toBe(400);
    expect(json).toEqual({ message: 'Could not read the body' });
    expect(h.connectDB).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('rejects a delivery missing the x-github-event header', async () => {
    const { status, json } = await deliver({ event: null });

    expect(status).toBe(400);
    expect(json).toEqual({ message: 'Missing x-github-event header' });
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });
});

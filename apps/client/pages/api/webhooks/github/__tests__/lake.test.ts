import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';

const h = vi.hoisted(() => ({
  config: {} as Record<string, string | undefined>,
  connectDB: vi.fn(),
  findByInstallationId: vi.fn(),
  recordLastError: vi.fn(),
  sendToQueue: vi.fn(),
  cache: new Map<string, { result: unknown }>(),
}));

vi.mock('@server/utils/config', () => ({
  Config: new Proxy({}, { get: (_target, key: string) => h.config[key] }),
}));

vi.mock('@bike4mind/database', () => ({
  connectDB: h.connectDB,
  // In memory, so the real per-delivery pinning in resolveRevokedConnectionIds runs end to end.
  cacheRepository: {
    findByKey: vi.fn(async (key: string) => h.cache.get(key) ?? null),
    createOrUpdate: vi.fn(async ({ key, result }: { key: string; result: unknown }) => {
      h.cache.set(key, { result });
    }),
  },
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
const { Logger } = await import('@bike4mind/observability');
const routeLogger = () =>
  vi.mocked(Logger).mock.results.at(-1)?.value as Record<'info' | 'warn', ReturnType<typeof vi.fn>>;
const IGNORED = '[githubLakeWebhook] ignored delivery';
const expectIgnored = (reason: string, fields: Record<string, unknown>) =>
  expect(routeLogger().info).toHaveBeenCalledWith(IGNORED, { reason, deliveryId: 'delivery-1', ...fields });

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

function installationPayload(overrides: Record<string, unknown> = {}) {
  return { action: 'deleted', installation: { id: INSTALLATION_ID }, ...overrides };
}

function installationRepositoriesPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'removed',
    installation: { id: INSTALLATION_ID },
    repositories_removed: [{ id: REPOSITORY_ID }],
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
  deliveryId?: string | null;
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
  deliveryId = 'delivery-1',
  reqError,
}: Delivery = {}) {
  const resolvedRawBody = rawBody ?? JSON.stringify(body);
  const headers: Record<string, string> = {};
  if (deliveryId !== null) headers['x-github-delivery'] = deliveryId;
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
    h.cache.clear();
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
    expect(routeLogger().info).not.toHaveBeenCalledWith(IGNORED, expect.anything());
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

  it.each(['my-secret-placeholder-value', ' Not-Configured '])(
    'refuses a delivery signed with the reserved placeholder secret %j',
    async placeholder => {
      h.config.GITHUB_LAKE_APP_WEBHOOK_SECRET = placeholder;
      const { status } = await deliver({
        event: 'installation',
        body: installationPayload(),
        signature: sign(JSON.stringify(installationPayload()), placeholder),
      });

      expect(status).toBe(503);
      expect(h.connectDB).not.toHaveBeenCalled();
      expect(h.sendToQueue).not.toHaveBeenCalled();
    }
  );

  it('ignores a push to a branch other than the default', async () => {
    const { status, json } = await deliver({ body: pushPayload({ ref: 'refs/heads/feature/x' }) });

    expect(status).toBe(200);
    expect(json).toEqual({ status: 'ignored', reason: 'not the default branch' });
    expect(h.sendToQueue).not.toHaveBeenCalled();
    expectIgnored('not_default_branch', { event: 'push', ref: 'refs/heads/feature/x', defaultBranch: 'main' });
  });

  it('ignores a tag push whose name matches the default branch', async () => {
    const { status } = await deliver({ body: pushPayload({ ref: 'refs/tags/main' }) });

    expect(status).toBe(200);
    expect(h.sendToQueue).not.toHaveBeenCalled();
    expectIgnored('not_default_branch', { event: 'push', ref: 'refs/tags/main', defaultBranch: 'main' });
  });

  it('ignores a deletion of the default branch, logged apart from a non-default push', async () => {
    const { status, json } = await deliver({ body: pushPayload({ deleted: true }) });

    expect(status).toBe(200);
    expect(json).toEqual({ status: 'ignored', reason: 'not the default branch' });
    expect(h.sendToQueue).not.toHaveBeenCalled();
    expectIgnored('branch_deleted', { event: 'push', ref: 'refs/heads/main', defaultBranch: 'main' });
  });

  it('logs a deleted non-default branch as not_default_branch', async () => {
    await deliver({ body: pushPayload({ ref: 'refs/heads/feature/x', deleted: true }) });

    expectIgnored('not_default_branch', { event: 'push', ref: 'refs/heads/feature/x', defaultBranch: 'main' });
    expect(routeLogger().info).not.toHaveBeenCalledWith(IGNORED, expect.objectContaining({ reason: 'branch_deleted' }));
  });

  it('acknowledges a signed non-push, non-revocation event without queueing', async () => {
    const { status, json } = await deliver({ event: 'ping', body: { zen: 'Keep it logically awesome.' } });

    expect(status).toBe(200);
    expect(json).toEqual({ status: 'ignored', reason: 'not a handled event' });
    expect(h.sendToQueue).not.toHaveBeenCalled();
    expectIgnored('unhandled_event', { event: 'ping' });
  });

  it('ignores a push for a repository no lake is connected to', async () => {
    h.findByInstallationId.mockResolvedValue([{ ...connection, repositoryId: 9999 }]);
    const { status, json } = await deliver();

    expect(status).toBe(200);
    expect(json).toEqual({ status: 'ignored', reason: 'no enabled lake for this repository' });
    expect(h.sendToQueue).not.toHaveBeenCalled();
    expectIgnored('no_connection', { event: 'push', installationId: INSTALLATION_ID, repositoryId: REPOSITORY_ID });
  });

  it('ignores a push for a disabled connection', async () => {
    h.findByInstallationId.mockResolvedValue([{ ...connection, enabled: false }]);
    const { status, json } = await deliver();

    expect(status).toBe(200);
    expect(json).toEqual({ status: 'ignored', reason: 'no enabled lake for this repository' });
    expect(h.sendToQueue).not.toHaveBeenCalled();
    expectIgnored('connection_disabled', { event: 'push', connectionId: 'conn1' });
  });

  it('rejects a signed push payload with no installation', async () => {
    // A plain repo webhook (not the App) carries no installation.
    const { status } = await deliver({ body: pushPayload({ installation: undefined }) });

    expect(status).toBe(400);
    expect(h.sendToQueue).not.toHaveBeenCalled();
    expect(routeLogger().warn).toHaveBeenCalledWith(
      '[githubLakeWebhook] push payload has an unexpected shape',
      expect.objectContaining({ deliveryId: 'delivery-1', error: expect.any(String) })
    );
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

  it('revokes every connection bound to the installation on installation.deleted', async () => {
    h.findByInstallationId.mockResolvedValue([
      { id: 'conn1', installationId: INSTALLATION_ID, repositoryId: 100, enabled: true },
      { id: 'conn2', installationId: INSTALLATION_ID, repositoryId: 200, enabled: true },
    ]);
    const { status, json } = await deliver({ event: 'installation', body: installationPayload() });

    expect(status).toBe(202);
    expect(json).toEqual({ status: 'queued', count: 2 });
    expect(h.connectDB).toHaveBeenCalledTimes(1);
    expect(h.findByInstallationId).toHaveBeenCalledWith(INSTALLATION_ID);
    expect(h.sendToQueue).toHaveBeenCalledWith('https://sqs.test/githubLakeRevokeQueue', {
      connectionId: 'conn1',
      installationId: INSTALLATION_ID,
    });
    expect(h.sendToQueue).toHaveBeenCalledWith('https://sqs.test/githubLakeRevokeQueue', {
      connectionId: 'conn2',
      installationId: INSTALLATION_ID,
    });
  });

  it('revokes only the removed repositories on installation_repositories.removed', async () => {
    h.findByInstallationId.mockResolvedValue([
      { id: 'conn1', installationId: INSTALLATION_ID, repositoryId: REPOSITORY_ID, enabled: true },
      { id: 'conn2', installationId: INSTALLATION_ID, repositoryId: 200, enabled: true },
    ]);
    const { status, json } = await deliver({
      event: 'installation_repositories',
      body: installationRepositoriesPayload(),
    });

    expect(status).toBe(202);
    expect(json).toEqual({ status: 'queued', count: 1 });
    expect(h.sendToQueue).toHaveBeenCalledTimes(1);
    expect(h.sendToQueue).toHaveBeenCalledWith('https://sqs.test/githubLakeRevokeQueue', {
      connectionId: 'conn1',
      installationId: INSTALLATION_ID,
    });
  });

  it('ignores installation_repositories.added, touching no repository', async () => {
    const { status, json } = await deliver({
      event: 'installation_repositories',
      body: { action: 'added', installation: { id: INSTALLATION_ID }, repositories_added: [{ id: REPOSITORY_ID }] },
    });

    expect(status).toBe(200);
    expect(json).toEqual({ status: 'ignored', reason: 'not a revoking action' });
    expect(h.connectDB).not.toHaveBeenCalled();
    expect(h.findByInstallationId).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
    expectIgnored('not_revoking_action', { event: 'installation_repositories', action: 'added' });
  });

  it('ignores installation.suspend (reversible, not a revoke)', async () => {
    const { status, json } = await deliver({
      event: 'installation',
      body: installationPayload({ action: 'suspend' }),
    });

    expect(status).toBe(200);
    expect(json).toEqual({ status: 'ignored', reason: 'not a revoking action' });
    expect(h.connectDB).not.toHaveBeenCalled();
    expect(h.findByInstallationId).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
    expectIgnored('not_revoking_action', { event: 'installation', action: 'suspend' });
  });

  it('400s a malformed installation.deleted payload missing the installation id', async () => {
    const { status, json } = await deliver({ event: 'installation', body: { action: 'deleted' } });

    expect(status).toBe(400);
    expect(json).toEqual({ message: 'Malformed payload' });
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('400s a removed delivery that names no repository, rather than acknowledging it as queued: 0', async () => {
    const { status, json } = await deliver({
      event: 'installation_repositories',
      body: installationRepositoriesPayload({ repositories_removed: [] }),
    });

    expect(status).toBe(400);
    expect(json).toEqual({ message: 'Malformed payload' });
    expect(h.findByInstallationId).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('queues count: 0 and enqueues nothing when a handled event matches no binding', async () => {
    h.findByInstallationId.mockResolvedValue([
      { id: 'conn1', installationId: INSTALLATION_ID, repositoryId: 999, enabled: true },
    ]);
    const { status, json } = await deliver({
      event: 'installation_repositories',
      body: installationRepositoriesPayload(),
    });

    expect(status).toBe(202);
    expect(json).toEqual({ status: 'queued', count: 0 });
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('queues count: 0 for an installation.deleted whose installation has no binding left', async () => {
    h.findByInstallationId.mockResolvedValue([]);
    const { status, json } = await deliver({ event: 'installation', body: installationPayload() });

    expect(status).toBe(202);
    expect(json).toEqual({ status: 'queued', count: 0 });
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('500s a partial multi-connection enqueue failure, and a redelivery re-enqueues every connection', async () => {
    h.findByInstallationId.mockResolvedValue([
      { id: 'conn1', installationId: INSTALLATION_ID, repositoryId: 100, enabled: true },
      { id: 'conn2', installationId: INSTALLATION_ID, repositoryId: 200, enabled: true },
    ]);
    h.sendToQueue.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('SQS throttled'));
    const first = await deliver({ event: 'installation', body: installationPayload() });

    expect(first.status).toBe(500);
    expect(first.json).toEqual({ message: 'Could not queue the revoke' });

    // The redelivery re-sends the pinned set, so conn1 is queued twice; revokeGitHubLakeConnection is idempotent.
    h.sendToQueue.mockClear();
    h.sendToQueue.mockResolvedValue(undefined);
    const redelivery = await deliver({ event: 'installation', body: installationPayload() });

    expect(redelivery.status).toBe(202);
    expect(redelivery.json).toEqual({ status: 'queued', count: 2 });
    expect(h.sendToQueue.mock.calls.map(([, message]) => message.connectionId)).toEqual(['conn1', 'conn2']);
  });

  it('does not revoke a connection made after the event when the same delivery is redelivered', async () => {
    const first = await deliver({ event: 'installation_repositories', body: installationRepositoriesPayload() });
    expect(first.status).toBe(202);
    expect(h.sendToQueue).toHaveBeenCalledWith('https://sqs.test/githubLakeRevokeQueue', {
      connectionId: 'conn1',
      installationId: INSTALLATION_ID,
    });

    // The user re-grants the repository and reconnects: a new row binds the same repository.
    h.findByInstallationId.mockResolvedValue([{ ...connection, id: 'conn1-prime' }]);
    h.sendToQueue.mockClear();
    const redelivery = await deliver({ event: 'installation_repositories', body: installationRepositoriesPayload() });

    expect(redelivery.status).toBe(202);
    expect(h.sendToQueue.mock.calls.map(([, message]) => message.connectionId)).toEqual(['conn1']);
  });

  it('resolves a different delivery against the live bindings', async () => {
    await deliver({ event: 'installation_repositories', body: installationRepositoriesPayload() });
    h.findByInstallationId.mockResolvedValue([{ ...connection, id: 'conn1-prime' }]);
    h.sendToQueue.mockClear();

    await deliver({
      event: 'installation_repositories',
      body: installationRepositoriesPayload(),
      deliveryId: 'delivery-2',
    });

    expect(h.sendToQueue.mock.calls.map(([, message]) => message.connectionId)).toEqual(['conn1-prime']);
  });

  it('400s a revoking event with no x-github-delivery header, since it cannot be pinned', async () => {
    const { status, json } = await deliver({ event: 'installation', body: installationPayload(), deliveryId: null });

    expect(status).toBe(400);
    expect(json).toEqual({ message: 'Missing x-github-delivery header' });
    expect(h.findByInstallationId).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('500s and logs when resolving the affected connections fails', async () => {
    h.findByInstallationId.mockRejectedValue(new Error('mongo down'));
    const { status, json } = await deliver({ event: 'installation', body: installationPayload() });

    expect(status).toBe(500);
    expect(json).toEqual({ message: 'Could not resolve the revoke' });
    expect(h.sendToQueue).not.toHaveBeenCalled();
    const logger = vi.mocked(Logger).mock.results.at(-1)?.value as { error: ReturnType<typeof vi.fn> };
    expect(logger.error).toHaveBeenCalledWith(
      '[githubLakeWebhook] could not resolve the revoked connections',
      expect.objectContaining({ deliveryId: 'delivery-1', installationId: INSTALLATION_ID })
    );
  });

  it('500s when the revoke enqueue fails, without throwing', async () => {
    h.findByInstallationId.mockResolvedValue([
      { id: 'conn1', installationId: INSTALLATION_ID, repositoryId: REPOSITORY_ID, enabled: true },
    ]);
    h.sendToQueue.mockRejectedValue(new Error('SQS down'));
    const { status, json } = await deliver({ event: 'installation', body: installationPayload() });

    expect(status).toBe(500);
    expect(json).toEqual({ message: 'Could not queue the revoke' });
    expect(h.sendToQueue).toHaveBeenCalledWith('https://sqs.test/githubLakeRevokeQueue', {
      connectionId: 'conn1',
      installationId: INSTALLATION_ID,
    });
  });

  it('rejects an installation event with an invalid signature', async () => {
    const { status } = await deliver({
      event: 'installation',
      body: installationPayload(),
      signature: 'sha256=deadbeef',
    });

    expect(status).toBe(401);
    expect(h.findByInstallationId).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });
});

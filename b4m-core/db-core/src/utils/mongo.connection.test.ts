import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { connection, connect, ping, logger } = vi.hoisted(() => {
  const ping = vi.fn();
  return {
    ping,
    connection: { readyState: 0, getClient: () => ({ db: () => ({ command: ping }) }) },
    connect: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

vi.mock('mongoose', () => ({ default: { connection, connect } }));
vi.mock('@bike4mind/observability', () => ({ Logger: { withMetadata: () => logger } }));
vi.mock('../certs/documentdb-cert-manager', () => ({
  isDocumentDBConnection: (url: string) => url.includes('docdb'),
  getDocumentDBCertificate: () => ({ certPath: '/tmp/test-ca.pem', certExists: true }),
  addCertificateToUri: (url: string) => `${url}?tlsCAFile=/tmp/test-ca.pem`,
}));

const atlasUrl = 'mongodb://atlas.example/test';
const networkError = () =>
  Object.assign(new Error('This socket has been ended by the other party'), {
    name: 'MongoNetworkError',
    code: 'EPIPE',
  });

describe('connectDB connection lifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01'));
    for (const key of ['AWS_LAMBDA_FUNCTION_NAME', 'VERCEL', 'MONGODB_MAX_IDLE_TIME_MS', 'MONGODB_MAX_POOL_SIZE']) {
      vi.stubEnv(key, undefined);
    }
    vi.stubEnv('MONGODB_MAX_RETRIES', '0');
    connection.readyState = 0;
    connect.mockReset().mockImplementation(async () => {
      connection.readyState = 1;
    });
    ping.mockReset().mockResolvedValue({ ok: 1 });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it.each(['AWS_LAMBDA_FUNCTION_NAME', 'VERCEL'])('expires idle Atlas sockets under %s', async runtime => {
    vi.stubEnv(runtime, 'test-function');
    const { connectDB } = await import('./mongo');
    await expect(connectDB(atlasUrl)).resolves.toBe(true);
    expect(connect).toHaveBeenCalledWith(
      atlasUrl,
      expect.objectContaining({
        maxIdleTimeMS: 30_000,
        minPoolSize: 0,
        retryReads: true,
        retryWrites: true,
      })
    );
  });

  it('keeps long-running pool defaults', async () => {
    const { connectDB } = await import('./mongo');
    await connectDB(atlasUrl);
    expect(connect.mock.calls[0][1]).toMatchObject({ minPoolSize: 1 });
    expect(connect.mock.calls[0][1]).not.toHaveProperty('maxIdleTimeMS');
    vi.advanceTimersByTime(60_000);
    await connectDB(atlasUrl);
    expect(ping).not.toHaveBeenCalled();
  });

  it('preserves DocumentDB expiry and retryable-write settings', async () => {
    const { connectDB } = await import('./mongo');
    await connectDB('mongodb://docdb.example/test');
    expect(connect).toHaveBeenCalledWith(
      'mongodb://docdb.example/test?tlsCAFile=/tmp/test-ca.pem',
      expect.objectContaining({ maxIdleTimeMS: 30_000, retryWrites: false })
    );
  });

  it.each(['0', '15000'])('honors the idle-time environment override %s', async idleTime => {
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'test-function');
    vi.stubEnv('MONGODB_MAX_IDLE_TIME_MS', idleTime);
    const { connectDB } = await import('./mongo');
    await connectDB(atlasUrl);
    expect(connect.mock.calls[0][1].maxIdleTimeMS).toBe(Number(idleTime));
  });

  it.each(['0', '15000'])('applies the idle-time environment override to a long-running process %s', async idleTime => {
    vi.stubEnv('MONGODB_MAX_IDLE_TIME_MS', idleTime);
    const { connectDB } = await import('./mongo');
    await connectDB(atlasUrl);
    expect(connect.mock.calls[0][1]).toMatchObject({ maxIdleTimeMS: Number(idleTime), minPoolSize: 1 });
  });

  it('merges caller pool overrides last', async () => {
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'test-function');
    const { connectDB } = await import('./mongo');
    await connectDB(atlasUrl, undefined, { maxIdleTimeMS: 0, minPoolSize: 2 });
    expect(connect.mock.calls[0][1]).toMatchObject({ maxIdleTimeMS: 0, minPoolSize: 2 });
  });

  it('shares cold connection establishment across callers', async () => {
    const { connectDB } = await import('./mongo');
    await Promise.all([connectDB(atlasUrl), connectDB(atlasUrl)]);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('checks after inactivity and makes concurrent callers wait for the ping', async () => {
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'test-function');
    const { connectDB } = await import('./mongo');
    await connectDB(atlasUrl);
    await connectDB(atlasUrl);
    expect(ping).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    const deferredPing = Promise.withResolvers<{ ok: number }>();
    ping.mockReturnValueOnce(deferredPing.promise);
    const first = connectDB(atlasUrl);
    const second = connectDB(atlasUrl);
    const completed = vi.fn();
    void second.then(completed);
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    expect(ping).toHaveBeenCalledExactlyOnceWith({ ping: 1 });
    deferredPing.resolve({ ok: 1 });
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    await connectDB(atlasUrl);
    expect(ping).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('retries a failed network ping before allowing request work', async () => {
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'test-function');
    connection.readyState = 1;
    ping.mockRejectedValueOnce(networkError());
    const { connectDB } = await import('./mongo');
    await expect(connectDB(atlasUrl)).resolves.toBe(true);
    expect(ping).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();
  });

  it('rejects all waiters if recovery fails and checks again on the next call', async () => {
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'test-function');
    connection.readyState = 1;
    const error = networkError();
    ping.mockRejectedValue(error);
    const { connectDB } = await import('./mongo');
    const outcomes = await Promise.allSettled([connectDB(atlasUrl), connectDB(atlasUrl)]);
    expect(outcomes).toEqual([
      { status: 'rejected', reason: error },
      { status: 'rejected', reason: error },
    ]);
    expect(ping).toHaveBeenCalledTimes(2);
    ping.mockResolvedValue({ ok: 1 });
    await expect(connectDB(atlasUrl)).resolves.toBe(true);
    expect(ping).toHaveBeenCalledTimes(3);
  });

  it('propagates non-network ping errors without retrying', async () => {
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'test-function');
    connection.readyState = 1;
    const error = new Error('Unauthorized');
    ping.mockRejectedValue(error);
    const { connectDB } = await import('./mongo');
    await expect(connectDB(atlasUrl)).rejects.toBe(error);
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it('propagates a non-network error from the retry ping', async () => {
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'test-function');
    connection.readyState = 1;
    const error = new Error('Unauthorized');
    ping.mockRejectedValueOnce(networkError()).mockRejectedValue(error);
    const { connectDB } = await import('./mongo');
    await expect(connectDB(atlasUrl)).rejects.toBe(error);
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it('does not retry a server-selection timeout', async () => {
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'test-function');
    connection.readyState = 1;
    const error = Object.assign(new Error('Server selection timed out after 30000 ms'), {
      name: 'MongoServerSelectionError',
    });
    ping.mockRejectedValue(error);
    const { connectDB } = await import('./mongo');
    await expect(connectDB(atlasUrl)).rejects.toBe(error);
    expect(ping).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('allows another connection attempt after a cold-start failure', async () => {
    const error = new Error('Connection refused');
    connect.mockRejectedValueOnce(error);
    const { connectDB } = await import('./mongo');
    await expect(connectDB(atlasUrl)).rejects.toThrow('Database connection failed');
    await expect(connectDB(atlasUrl)).resolves.toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
  });
});

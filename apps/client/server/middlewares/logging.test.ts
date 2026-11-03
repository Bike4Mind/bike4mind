import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@bike4mind/server-utils/utils/config', () => ({
  Config: { STAGE: 'test' },
}));

import { logging } from './logging';
import { REQUEST_ID_HEADER } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';

function makeReqRes(headers: Record<string, string | string[] | undefined> = {}, url = '/api/chat') {
  // any: lightweight stand-ins for Express req/res - only the fields logging() touches
  const req = {
    headers,
    query: {},
    url,
    method: 'POST',
    connection: { remoteAddress: '127.0.0.1' },
  } as any;
  const setHeader = vi.fn();
  const res = { setHeader } as any;
  const next = vi.fn();
  return { req, res, setHeader, next };
}

let infoSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  Logger.resetMetadata();
});

function lastLines() {
  return infoSpy.mock.calls.map(c => JSON.parse(c[0] as string) as Record<string, unknown>);
}

function logLine(logger: Logger) {
  infoSpy.mockClear();
  logger.info('x');
  return lastLines()[0];
}

describe('logging middleware — request ID correlation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('echoes a caller-provided X-Request-ID', () => {
    const { req, res, setHeader, next } = makeReqRes({ 'x-request-id': 'caller-trace-1' });
    logging(req, res, next);
    expect(req.requestId).toBe('caller-trace-1');
    expect(setHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER, 'caller-trace-1');
    expect(next).toHaveBeenCalledOnce();
  });

  it('accepts the legacy Request-ID header', () => {
    const { req, res, setHeader, next } = makeReqRes({ 'request-id': 'legacy-trace-2' });
    logging(req, res, next);
    expect(req.requestId).toBe('legacy-trace-2');
    expect(setHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER, 'legacy-trace-2');
  });

  it('prefers X-Request-ID over the legacy Request-ID header', () => {
    const { req, res, next } = makeReqRes({ 'x-request-id': 'new-name', 'request-id': 'old-name' });
    logging(req, res, next);
    expect(req.requestId).toBe('new-name');
  });

  it('sanitizes a caller value to prevent log injection', () => {
    const { req, res, setHeader, next } = makeReqRes({ 'x-request-id': 'evil\r\ninjected' });
    logging(req, res, next);
    expect(req.requestId).toBe('evilinjected');
    expect(setHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER, 'evilinjected');
  });

  it('generates a request ID when the caller provides none', () => {
    const { req, res, setHeader, next } = makeReqRes();
    logging(req, res, next);
    expect(typeof req.requestId).toBe('string');
    expect(req.requestId.length).toBeGreaterThan(0);
    expect(setHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER, req.requestId);
  });

  it('records the request ID in logger metadata', () => {
    const { req, res, next } = makeReqRes({ 'x-request-id': 'meta-trace' });
    logging(req, res, next);
    expect(logLine(req.logger).requestId).toBe('meta-trace');
  });

  it('preserves the AWS X-Ray trace ID under a separate traceId key', () => {
    const { req, res, next } = makeReqRes({
      'x-request-id': 'caller-1',
      'x-amzn-trace-id': 'Root=1-abc-def',
    });
    logging(req, res, next);
    expect(logLine(req.logger)).toMatchObject({ requestId: 'caller-1', traceId: 'Root=1-abc-def' });
  });

  it('omits traceId when no X-Ray header is present', () => {
    const { req, res, next } = makeReqRes({ 'x-request-id': 'caller-2' });
    logging(req, res, next);
    expect(logLine(req.logger)).not.toHaveProperty('traceId');
  });
});

describe('logging middleware - per-request log context', () => {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  async function runRequest(id: string, url: string, delayMs: number, work?: (req: any) => void) {
    const { req, res, next } = makeReqRes({ 'x-request-id': id }, url);
    let done!: Promise<void>;
    next.mockImplementation(() => {
      done = (async () => {
        work?.(req);
        await sleep(delayMs);
        Logger.info('static');
      })();
    });
    logging(req, res, next);
    await done;
  }

  it('keeps interleaved requests on their own metadata', async () => {
    await Promise.all([runRequest('a', '/api/a', 15), runRequest('b', '/api/b', 1)]);
    const lines = lastLines();
    expect(lines.find(l => l.requestId === 'a')).toMatchObject({ path: '/api/a' });
    expect(lines.find(l => l.requestId === 'b')).toMatchObject({ path: '/api/b' });
    expect(lines).toHaveLength(2);
  });

  it('keeps userId inside the request that set it', async () => {
    await Promise.all([
      runRequest('a', '/api/a', 10, req => req.logger.updateMetadata({ userId: 'u1' })),
      runRequest('b', '/api/b', 1),
    ]);
    const lines = lastLines();
    expect(lines.find(l => l.requestId === 'a')).toMatchObject({ userId: 'u1' });
    expect(lines.find(l => l.requestId === 'b')).not.toHaveProperty('userId');

    infoSpy.mockClear();
    Logger.info('outside');
    expect(lastLines()[0]).not.toHaveProperty('userId');
    expect(lastLines()[0]).not.toHaveProperty('requestId');
  });
});

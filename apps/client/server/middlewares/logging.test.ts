import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@server/utils/config', () => ({
  Config: { STAGE: 'test' },
}));

vi.mock('@bike4mind/observability', () => {
  const loggerStub: { updateMetadata: ReturnType<typeof vi.fn> } = {
    updateMetadata: vi.fn(() => loggerStub),
  };
  return {
    Logger: { resetMetadata: vi.fn(() => loggerStub) },
  };
});

import { logging } from './logging';
import { REQUEST_ID_HEADER } from '@bike4mind/common';

function makeReqRes(headers: Record<string, string | string[] | undefined> = {}) {
  // any: lightweight stand-ins for Express req/res - only the fields logging() touches
  const req = {
    headers,
    query: {},
    url: '/api/chat',
    method: 'POST',
    connection: { remoteAddress: '127.0.0.1' },
  } as any;
  const setHeader = vi.fn();
  const res = { setHeader } as any;
  const next = vi.fn();
  return { req, res, setHeader, next };
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
    expect(req.logger.updateMetadata).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'meta-trace' }));
  });

  it('preserves the AWS X-Ray trace ID under a separate traceId key', () => {
    const { req, res, next } = makeReqRes({
      'x-request-id': 'caller-1',
      'x-amzn-trace-id': 'Root=1-abc-def',
    });
    logging(req, res, next);
    expect(req.logger.updateMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'caller-1', traceId: 'Root=1-abc-def' })
    );
  });

  it('omits traceId when no X-Ray header is present', () => {
    const { req, res, next } = makeReqRes({ 'x-request-id': 'caller-2' });
    logging(req, res, next);
    const metadata = (req.logger.updateMetadata as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(metadata).not.toHaveProperty('traceId');
  });
});

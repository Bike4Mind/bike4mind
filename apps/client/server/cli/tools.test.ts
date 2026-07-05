import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

// Keep @bike4mind/common real so resolveRequestId / sanitizeRequestId and the
// header constants run for real - this is an integration test of the handler's
// request-ID plumbing and header/body parity, not a unit test.

vi.mock('@server/utils/config', () => ({
  Config: { MONGODB_URI: 'mongodb://test/%STAGE%', STAGE: 'test' },
}));

vi.mock('@bike4mind/observability', () => {
  class Logger {
    updateMetadata = vi.fn(() => this);
    info = vi.fn();
    error = vi.fn();
    debug = vi.fn();
    warn = vi.fn();
  }
  return { Logger };
});

vi.mock('@bike4mind/utils', () => ({
  registerLambdaErrorHandlers: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn(),
  // readyState 1 === connected, so the handler skips connectDB entirely
  mongoose: { connection: { readyState: 1 } },
  adminSettingsRepository: {},
  apiKeyRepository: {},
  toolExecutionLogRepository: {},
}));

vi.mock('@bike4mind/services', () => ({ cliTools: { executeServerTool: vi.fn() } }));

vi.mock('./auth', () => ({
  verifyJwtToken: vi.fn(),
  checkRateLimit: vi.fn(),
}));

// Keep the real validateToolRequest (pure), stub only executeToolWithLogging
// so we can drive the result/handled-failure branches deterministically.
vi.mock('./toolsHandler.shared', async importOriginal => {
  const actual = await importOriginal<typeof import('./toolsHandler.shared')>();
  return { ...actual, executeToolWithLogging: vi.fn() };
});

import { handleToolRequest } from './tools';
import { executeToolWithLogging } from './toolsHandler.shared';
import { verifyJwtToken, checkRateLimit } from './auth';
import { REQUEST_ID_HEADER } from '@bike4mind/common';

const VALID_BODY = JSON.stringify({ toolName: 'weather_info', input: { city: 'Tokyo' } });

function makeEvent(opts: { body?: string; headers?: Record<string, string> }): APIGatewayProxyEventV2 {
  // any: minimal stand-in - only the fields the handler actually reads
  return {
    headers: { authorization: 'Bearer token', ...(opts.headers ?? {}) },
    body: opts.body,
    rawPath: '/api/ai/v1/tools',
    requestContext: { http: { method: 'POST' } },
  } as any;
}

function parse(result: APIGatewayProxyStructuredResultV2) {
  return {
    status: result.statusCode,
    header: result.headers?.[REQUEST_ID_HEADER],
    body: JSON.parse(result.body as string),
  };
}

describe('tools Lambda handler — request ID correlation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyJwtToken).mockResolvedValue({ id: 'user-1', email: 'u@example.com' } as any);
    vi.mocked(checkRateLimit).mockResolvedValue(undefined);
  });

  it('echoes a caller X-Request-ID in both header and body on the success result path', async () => {
    vi.mocked(executeToolWithLogging).mockResolvedValue({ success: true, data: { temp: 21 } } as any);

    const { status, header, body } = parse(
      (await handleToolRequest(makeEvent({ body: VALID_BODY, headers: { 'x-request-id': 'caller-1' } }))) as any
    );

    expect(status).toBe(200);
    expect(header).toBe('caller-1');
    expect(body.request_id).toBe('caller-1');
    // result fields are preserved alongside the echoed id
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ temp: 21 });
  });

  it('includes request_id on the handled-failure result path (500)', async () => {
    vi.mocked(executeToolWithLogging).mockResolvedValue({
      success: false,
      error: 'tool blew up',
    } as any);

    const { status, header, body } = parse(
      (await handleToolRequest(makeEvent({ body: VALID_BODY, headers: { 'x-request-id': 'caller-2' } }))) as any
    );

    expect(status).toBe(500);
    expect(header).toBe('caller-2');
    expect(body.request_id).toBe('caller-2');
    expect(body.success).toBe(false);
  });

  it('accepts the legacy Request-ID header on the result path', async () => {
    vi.mocked(executeToolWithLogging).mockResolvedValue({ success: true } as any);

    const { header, body } = parse(
      (await handleToolRequest(makeEvent({ body: VALID_BODY, headers: { 'request-id': 'legacy-1' } }))) as any
    );

    expect(header).toBe('legacy-1');
    expect(body.request_id).toBe('legacy-1');
  });

  it('generates a request ID when the caller provides none, and header matches body', async () => {
    vi.mocked(executeToolWithLogging).mockResolvedValue({ success: true } as any);

    const { header, body } = parse((await handleToolRequest(makeEvent({ body: VALID_BODY }))) as any);

    expect(header).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.request_id).toBe(header);
  });

  it('echoes the request ID on the invalid-body error path', async () => {
    const { status, header, body } = parse(
      (await handleToolRequest(makeEvent({ body: '{invalid', headers: { 'x-request-id': 'caller-3' } }))) as any
    );

    expect(status).toBe(400);
    expect(header).toBe('caller-3');
    expect(body.request_id).toBe('caller-3');
    expect(executeToolWithLogging).not.toHaveBeenCalled();
  });

  it('echoes the request ID on the auth-failure error path (401)', async () => {
    vi.mocked(verifyJwtToken).mockRejectedValue(new Error('bad token'));

    const { status, header, body } = parse(
      (await handleToolRequest(makeEvent({ body: VALID_BODY, headers: { 'x-request-id': 'caller-4' } }))) as any
    );

    expect(status).toBe(401);
    expect(header).toBe('caller-4');
    expect(body.request_id).toBe('caller-4');
  });

  it('prefers a pre-resolved request ID passed by the wrapper over the event headers', async () => {
    vi.mocked(executeToolWithLogging).mockResolvedValue({ success: true } as any);

    const { header, body } = parse(
      (await handleToolRequest(
        makeEvent({ body: VALID_BODY, headers: { 'x-request-id': 'from-header' } }),
        'from-wrapper'
      )) as any
    );

    expect(header).toBe('from-wrapper');
    expect(body.request_id).toBe('from-wrapper');
  });
});

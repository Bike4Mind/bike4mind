import { describe, it, expect, vi } from 'vitest';
import { ApiErrorSchema, BadRequestError } from '@bike4mind/common';
import errorHandler from './errorHandler';

function makeReqRes() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  // any: lightweight stand-ins for Express req/res - only the fields errorHandler() touches
  const res = { status, json } as any;
  const req = {
    method: 'POST',
    url: '/api/chat',
    requestId: 'trace-err-1',
    logger: { error: vi.fn(), warn: vi.fn() },
  } as any;
  return { req, res, status, json };
}

describe('errorHandler — request_id in the error envelope', () => {
  it('includes request_id for a recognized error', () => {
    const { req, res, status, json } = makeReqRes();
    errorHandler({ name: 'BadRequestError', message: 'bad input', status: 400 }, req, res);
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ request_id: 'trace-err-1', error: 'bad input' }));
  });

  it('includes request_id for an unknown error shape', () => {
    const { req, res, json } = makeReqRes();
    errorHandler('totally unknown', req, res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ request_id: 'trace-err-1' }));
  });
});

describe('errorHandler - the body carries no keys the envelope does not document', () => {
  // The gate for CONVENTIONS.md section 1. errorHandler serves every route, so an
  // undocumented key it adds ships on the public surface with no contract declaring
  // it. ApiErrorSchema is the plain twin of the published ErrorResponse component
  // (b4m-core/common/src/openapi/schemas.ts) and must stay in sync with it; the
  // OpenAPI layer itself is generate-time only and cannot be imported here.
  const documented = Object.keys(ApiErrorSchema.shape);

  const bodyOf = (error: unknown) => {
    const { req, res, json } = makeReqRes();
    errorHandler(error, req, res);
    return json.mock.calls[0][0] as Record<string, unknown>;
  };

  it('adds nothing beyond the envelope for a recognized error', () => {
    for (const key of Object.keys(bodyOf({ name: 'BadRequestError', message: 'bad input', status: 400 }))) {
      expect(documented).toContain(key);
    }
  });

  it('adds nothing beyond the envelope for an unknown error shape', () => {
    for (const key of Object.keys(bodyOf('totally unknown'))) {
      expect(documented).toContain(key);
    }
  });

  // Pins the deprecation window rather than the field: `name` keeps shipping until the
  // sunset in ErrorResponse's description, and this fails the day someone drops it
  // from the runtime without also dropping it from the published envelope.
  it('still serves the deprecated `name` field until its sunset', () => {
    expect(bodyOf({ name: 'BadRequestError', message: 'bad input', status: 400 })).toMatchObject({
      name: 'BadRequestError',
    });
    expect(documented).toContain('name');
  });

  // additionalInfo carries the endpoint's own typed member, which the contract
  // declares; only the middleware's unconditional additions are pinned above.
  it('still spreads a typed additionalInfo member alongside the envelope', () => {
    expect(bodyOf(new BadRequestError('no credits', { errorCode: 'insufficient_credits' }))).toMatchObject({
      errorCode: 'insufficient_credits',
      error: 'no credits',
    });
  });
});

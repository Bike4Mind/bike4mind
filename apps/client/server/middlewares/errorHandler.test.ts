import { describe, it, expect, vi } from 'vitest';
import { ApiErrorSchema, BadRequestError } from '@bike4mind/common';
import { z } from 'zod';
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

  // The HTTPError branch is the only one that reaches `additionalInfo`, so without a
  // case here the membership loop above never runs against a populated one and a new
  // subclass spreading an undocumented key would ship with CI green. additionalInfo's
  // own members are the endpoint contract's business, so they are excluded by key -
  // what is pinned is that the *middleware* adds nothing else.
  it('adds nothing beyond the envelope for an HTTPError carrying additionalInfo', () => {
    const additionalInfo = { errorCode: 'insufficient_credits' };
    const body = bodyOf(new BadRequestError('no credits', additionalInfo));
    for (const key of Object.keys(body)) {
      if (key in additionalInfo) continue;
      expect(documented).toContain(key);
    }
  });
});

describe('errorHandler - CastError only means 404 when the cast was on `_id`', () => {
  // Mongoose sets `path` to the field it failed to cast. Only `_id` implies the caller
  // handed a route a junk resource id; anything else was thrown by our own code and a
  // 404 would report an expected client error where there is really a server bug.
  const castError = (path?: string) => ({
    name: 'CastError',
    message: `Cast to ObjectId failed for value "junk" at path "${path ?? 'unknown'}" for model "Feedback"`,
    ...(path === undefined ? {} : { path }),
  });

  it('maps a cast on `_id` to 404 and logs it as an expected client error', () => {
    const { req, res, status, json } = makeReqRes();
    errorHandler(castError('_id'), req, res);
    expect(status).toHaveBeenCalledWith(404);
    expect(req.logger.warn).toHaveBeenCalled();
    expect(req.logger.error).not.toHaveBeenCalled();
    // The NotFoundError substitution is what keeps the junk id and the model name off a
    // 404 body; without it the raw cast message would ship on the wire.
    expect(json.mock.calls[0][0]).toMatchObject({ name: 'NotFoundError', error: 'Resource not found' });
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain('Feedback');
  });

  it('leaves a cast on any other field a 500 and logs it as a server error', () => {
    const { req, res, status } = makeReqRes();
    errorHandler(castError('userId'), req, res);
    expect(status).toHaveBeenCalledWith(500);
    expect(req.logger.error).toHaveBeenCalled();
    expect(req.logger.warn).not.toHaveBeenCalled();
  });

  it('logs the full cast message even though the wire gets the generic one', () => {
    const { req, res } = makeReqRes();
    errorHandler(castError('userId'), req, res);
    expect(req.logger.error).toHaveBeenCalledWith(expect.stringContaining('userId'), expect.anything());
    expect(req.logger.error).toHaveBeenCalledWith(expect.stringContaining('Feedback'), expect.anything());
  });

  it('does not treat a CastError with no path as a missing resource', () => {
    const { req, res, status } = makeReqRes();
    errorHandler(castError(), req, res);
    expect(status).toHaveBeenCalledWith(500);
  });

  // A plain nested object is not a subdocument schema, so mongoose reports the dotted path.
  // Equality is load-bearing here: an `.endsWith('_id')` "simplification" would read this as
  // a missing resource and silently restore the blanket 404 this narrowing exists to remove.
  it('does not treat a dotted nested path ending in _id as a missing resource', () => {
    const { req, res, status } = makeReqRes();
    errorHandler(castError('nested._id'), req, res);
    expect(status).toHaveBeenCalledWith(500);
    expect(req.logger.error).toHaveBeenCalled();
    expect(req.logger.warn).not.toHaveBeenCalled();
  });

  it('keeps the schema field and model name out of the 500 body', () => {
    const { req, res, json } = makeReqRes();
    errorHandler(castError('userId'), req, res);
    // Mongoose's cast message names the model and the field it failed on. The blanket 404
    // used to mask those; the narrowing must not put them on a public wire instead.
    expect(json.mock.calls[0][0]).toMatchObject({ name: 'CastError', error: 'Server Error' });
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain('userId');
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain('Feedback');
    for (const key of Object.keys(json.mock.calls[0][0] as Record<string, unknown>)) {
      expect(Object.keys(ApiErrorSchema.shape)).toContain(key);
    }
  });

  it('adds nothing beyond the envelope for a CastError with no path', () => {
    const { req, res, json } = makeReqRes();
    errorHandler(castError(), req, res);
    for (const key of Object.keys(json.mock.calls[0][0] as Record<string, unknown>)) {
      expect(Object.keys(ApiErrorSchema.shape)).toContain(key);
    }
  });
});

describe('errorHandler - a ZodError becomes a 422', () => {
  // Per CONVENTIONS.md a schema rejection is a 422, and this branch is the only thing
  // that makes that true for every route that lets a ZodError reach the middleware. It
  // was previously unpinned: the route tests that throw one assert the raw
  // `{ name: 'ZodError' }` shape without ever going through errorHandler.
  const zodError = () => z.object({ days: z.number() }).safeParse({ days: 'abc' }).error!;

  it('maps it to 422 and logs it as an expected client error', () => {
    const { req, res, status } = makeReqRes();
    errorHandler(zodError(), req, res);
    expect(status).toHaveBeenCalledWith(422);
    expect(req.logger.warn).toHaveBeenCalled();
    expect(req.logger.error).not.toHaveBeenCalled();
  });

  it('reports the offending field without serializing zod internals', () => {
    const { req, res, json } = makeReqRes();
    errorHandler(zodError(), req, res);
    const body = json.mock.calls[0][0] as Record<string, unknown>;
    expect(body.name).toBe('UnprocessableEntityError');
    expect(String(body.error)).toContain('days');
    // fromZodError() flattens to a readable sentence; the raw issue objects carry keys
    // (`code`, `expected`, `_zod`) that are not in the envelope and must not reach a body.
    expect(JSON.stringify(body)).not.toContain('_zod');
    for (const key of Object.keys(body)) {
      expect(Object.keys(ApiErrorSchema.shape)).toContain(key);
    }
  });

  // Pins the fromZodError() call itself, not just the status. Asserting only the status and
  // the field name leaves the transformation unpinned: zod's raw `message` is a JSON dump of
  // the issue array and happens to contain the field name too, so dropping fromZodError()
  // would ship that dump on every 422 across baseApi with nothing failing.
  it('flattens the message rather than dumping the zod issue array', () => {
    const { req, res, json } = makeReqRes();
    errorHandler(zodError(), req, res);
    const message = String((json.mock.calls[0][0] as Record<string, unknown>).error);
    expect(message).toMatch(/^Validation error: /);
    expect(message).not.toContain('invalid_type');
    expect(message).not.toContain('"path"');
  });
});

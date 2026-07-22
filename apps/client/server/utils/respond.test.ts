import { describe, it, expect, vi } from 'vitest';
import * as z from 'zod';
import type { Response } from 'express';
import { InternalServerError } from '@bike4mind/common';
import { respond } from './respond';

/** Minimal Express Response double capturing status + json. */
function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn((payload: unknown) => {
      res.body = payload;
      return res;
    }),
  };
  return res as typeof res & Response;
}

const schema = z.object({
  id: z.string(),
  name: z.string(),
});

describe('respond', () => {
  it('sends the parsed data with a 200 by default', () => {
    const res = mockRes();
    respond(res, schema, { id: 'u1', name: 'Jane' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toEqual({ id: 'u1', name: 'Jane' });
  });

  it('strips fields not declared in the schema', () => {
    const res = mockRes();
    respond(res, schema, { id: 'u1', name: 'Jane', password: 'SECRET', token: 'SECRET' });
    expect(res.body).toEqual({ id: 'u1', name: 'Jane' });
    expect(JSON.stringify(res.body)).not.toContain('SECRET');
  });

  it('honors an explicit status code', () => {
    const res = mockRes();
    respond(res, schema, { id: 'u1', name: 'Jane' }, 201);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('fails loud on a shape mismatch: opaque 500, no client-visible detail, no json sent', () => {
    const res = mockRes();
    let thrown: unknown;
    try {
      respond(res, schema, { id: 'u1' }); // missing required `name`
    } catch (e) {
      thrown = e;
    }
    // A response-contract violation is a server bug -> 500, NOT the 422 + echoed-detail
    // path errorHandler applies to request-validation ZodErrors.
    expect(thrown).toBeInstanceOf(InternalServerError);
    expect((thrown as InternalServerError).statusCode).toBe(500);
    expect((thrown as Error).message).toBe('Response validation failed');
    // The ZodError rides along as `cause` for server-side logging, never echoed.
    expect((thrown as Error).cause).toBeDefined();
    expect(res.json).not.toHaveBeenCalled();
  });
});

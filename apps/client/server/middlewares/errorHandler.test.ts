import { describe, it, expect, vi } from 'vitest';
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

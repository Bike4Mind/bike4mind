import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { requireExperimentalFeature } from '../requireExperimentalFeature';

const makeRes = () => {
  const res = { status: vi.fn(), json: vi.fn() } as unknown as Response;
  (res.status as unknown as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
};

const run = (user: unknown) => {
  const req = { user, requestId: 'req-1' } as unknown as Request;
  const res = makeRes();
  const next = vi.fn();
  requireExperimentalFeature('enableQuestMasterV5')(req, res, next);
  return { res, next };
};

describe('requireExperimentalFeature', () => {
  it('passes a user who opted in via the plain-object bag', () => {
    const { next, res } = run({ preferences: { experimentalFeatures: { enableQuestMasterV5: true } } });
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  // A hydrated Mongoose user carries a Map here, not an object. Dot access on a
  // Map yields undefined silently, so a gate written the obvious way would deny
  // every opted-in user - the exact bug Mementos V2 shipped with once.
  it('passes a user whose bag is a hydrated Mongoose Map', () => {
    const { next } = run({ preferences: { experimentalFeatures: new Map([['enableQuestMasterV5', true]]) } });
    expect(next).toHaveBeenCalled();
  });

  it('denies a user who has not opted in', () => {
    const { next, res } = run({ preferences: { experimentalFeatures: { enableQuestMasterV5: false } } });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'FEATURE_DISABLED' }));
  });

  it('denies a user with no preferences at all', () => {
    const { next, res } = run({});
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('fails closed with no user on the request', () => {
    const { next, res } = run(undefined);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

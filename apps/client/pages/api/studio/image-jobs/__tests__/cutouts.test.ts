// @vitest-environment node
/**
 * Route tests for POST /api/studio/image-jobs/cutouts. `baseApi` and the feature flag are stubbed (no DB, no auth
 * chain); the route's own body validation, response shaping and refusal mapping run for real. The job itself (hold,
 * settle, refund, lineage) is covered in b4m-core/services/src/imageJobs/cutout.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Mw = (req: unknown, res: MockRes, next: () => void) => unknown;
type MockRes = { status: (code: number) => { json: (body: unknown) => unknown } };

const mocks = vi.hoisted(() => ({
  createCutoutJob: vi.fn(),
  getCreateImageJobsDeps: vi.fn(),
  resolveMediaBillingOrgId: vi.fn(),
  assertAiAccessAllowed: vi.fn(),
  flag: { open: true },
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const used: Mw[] = [];
    const routes: Record<string, Mw[]> = {};
    const dispatch = async (req: { method: string }, res: MockRes) => {
      const chain = [...used, ...(routes[req.method] ?? [])];
      for (const handler of chain) {
        let advanced = false;
        await handler(req, res, () => {
          advanced = true;
        });
        if (!advanced) return;
      }
    };
    const chain = Object.assign(dispatch, {
      use: (mw: Mw) => {
        used.push(mw);
        return chain;
      },
      post: (...handlers: Mw[]) => {
        routes.POST = handlers;
        return chain;
      },
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: unknown) => fn,
}));
vi.mock('@server/middlewares/perUserRateLimit', () => ({
  perUserRateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@bike4mind/server-utils/middlewares/studioFeatureFlag', () => ({
  requireStudioFeature: () => (_req: unknown, res: MockRes, next: () => void) =>
    mocks.flag.open ? next() : res.status(403).json({ error: 'FEATURE_DISABLED' }),
}));
vi.mock('@bike4mind/services/imageJobs', () => ({ createCutoutJob: mocks.createCutoutJob }));
vi.mock('@bike4mind/server-utils/generationJobs/wiring', () => ({ getCreateImageJobsDeps: mocks.getCreateImageJobsDeps }));
vi.mock('@server/billing/resolveMediaBillingOrgId', () => ({
  resolveMediaBillingOrgId: mocks.resolveMediaBillingOrgId,
}));
vi.mock('@bike4mind/server-utils/auth/assertAiAccessAllowed', () => ({
  assertAiAccessAllowed: mocks.assertAiAccessAllowed,
}));

const { default: handler } = await import('../cutouts');

const USER = { id: 'user-1' };
const DEPS = { deps: true };
const FILE_ID = 'c'.repeat(24);
const createdAt = new Date('2026-11-12T00:00:00.000Z');

const cutoutJob = {
  id: 'j1',
  kind: 'image',
  state: 'pending',
  creditHold: { id: 'hold-1', amount: 10 },
  createdAt,
  payload: {
    groupId: 'group-1',
    purpose: 'cutout',
    request: { model: 'gpt-image-1.5', mode: 'edit', inputs: [{ role: 'edit_source', fileId: FILE_ID }] },
  },
};

const call = async (body: unknown, headers: Record<string, string> = {}) => {
  const { req, res } = createMocks({ method: 'POST', body: body as Record<string, unknown>, headers });
  Object.assign(req, { user: USER });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return { status: res._getStatusCode(), body: res._getJSONData() as Record<string, unknown> };
};

describe('POST /api/studio/image-jobs/cutouts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.flag.open = true;
    mocks.getCreateImageJobsDeps.mockReturnValue(DEPS);
    mocks.resolveMediaBillingOrgId.mockResolvedValue('org-1');
  });

  it('answers 403 and creates nothing when the Studio image flag is off', async () => {
    mocks.flag.open = false;
    const { status } = await call({ fileId: FILE_ID });
    expect(status).toBe(403);
    expect(mocks.createCutoutJob).not.toHaveBeenCalled();
  });

  it('starts a cutout of the file for the caller and billing org, with its own idempotency scope', async () => {
    mocks.createCutoutJob.mockResolvedValue({ ok: true, created: true, groupId: 'group-1', jobs: [cutoutJob] });
    const { status, body } = await call({ fileId: FILE_ID }, { 'idempotency-key': 'k1' });

    expect(status).toBe(202);
    expect(mocks.createCutoutJob).toHaveBeenCalledWith(
      {
        user: { id: 'user-1', organizationId: 'org-1' },
        fileId: FILE_ID,
        source: 'studio',
        idempotencyKey: 'studio:image-cutout:user-1:k1',
      },
      DEPS
    );
    expect(body.job).toMatchObject({ id: 'j1', purpose: 'cutout', state: 'pending', output: null });
    expect(JSON.stringify(body)).not.toContain('creditHold');
  });

  it('answers 200 for an idempotent replay', async () => {
    mocks.createCutoutJob.mockResolvedValue({ ok: true, created: false, groupId: 'group-1', jobs: [cutoutJob] });
    expect((await call({ fileId: FILE_ID }, { 'idempotency-key': 'k1' })).status).toBe(200);
  });

  it.each([{}, { fileId: 'not-an-id' }, { fileId: FILE_ID, prompt: 'make it red' }])(
    'refuses a body that is not just a file id: %j',
    async body => {
      const result = await call(body);
      expect(result.status).toBe(400);
      expect(result.body.error).toBe('invalid_request');
      expect(mocks.createCutoutJob).not.toHaveBeenCalled();
    }
  );

  it('passes a refusal through with its status and code', async () => {
    mocks.createCutoutJob.mockResolvedValue({
      ok: false,
      status: 422,
      code: 'unsupported_input_image',
      message: 'Remove background works on PNG or JPEG images',
    });
    const { status, body } = await call({ fileId: FILE_ID });
    expect(status).toBe(422);
    expect(body).toEqual({
      error: 'unsupported_input_image',
      message: 'Remove background works on PNG or JPEG images',
    });
  });

  it('passes an insufficient balance through as 402', async () => {
    mocks.createCutoutJob.mockResolvedValue({
      ok: false,
      status: 402,
      code: 'insufficient_credits',
      message: 'Not enough credits',
    });
    expect((await call({ fileId: FILE_ID })).status).toBe(402);
  });
});

// @vitest-environment node
/**
 * Route tests for GET /api/image-jobs/[id]. `baseApi` is stubbed (no DB, no auth chain) and the job lookup is
 * mocked; the projection and the owner/kind lookup arguments run for real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { IGenerationJobDocumentOf } from '@bike4mind/common';

type Mw = (req: unknown, res: unknown, next: () => void) => unknown;

const mocks = vi.hoisted(() => ({
  findOwnGenerationJob: vi.fn(),
  sign: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    let handlers: Mw[] = [];
    const dispatch = async (req: unknown, res: unknown) => {
      for (const handler of handlers) {
        let advanced = false;
        await handler(req, res, () => {
          advanced = true;
        });
        if (!advanced) return;
      }
    };
    return Object.assign(dispatch, {
      get: (...registered: Mw[]) => {
        handlers = registered;
        return dispatch;
      },
    });
  },
}));
vi.mock('@server/middlewares/perUserRateLimit', () => ({
  perUserRateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/generations/findOwnGenerationJob', () => ({ findOwnGenerationJob: mocks.findOwnGenerationJob }));
vi.mock('@server/generations/routeDeps', () => ({
  mapperDeps: { sign: mocks.sign, now: () => new Date('2026-11-16T00:00:00Z') },
}));

const { default: handler } = await import('../[id]');

const JOB_ID = 'a'.repeat(24);
const FILE_ID = 'b'.repeat(24);

const job = (overrides: Partial<IGenerationJobDocumentOf<'image'>> = {}) =>
  ({
    id: JOB_ID,
    kind: 'image',
    state: 'succeeded',
    source: 'agent',
    requestedBy: 'user-1',
    payload: {
      request: { model: 'gpt-image-2', mode: 'generate', prompt: 'a red bicycle', quality: 'medium' },
      providerId: 'openai',
      groupId: 'group-1',
      groupSize: 2,
      output: { location: 'files', s3Key: 'k', fileId: FILE_ID, contentType: 'image/png', bytes: 10 },
    },
    creditHold: { reservedCredits: 5 },
    settledCredits: 4,
    createdAt: new Date('2026-11-15T00:00:00Z'),
    updatedAt: new Date('2026-11-15T00:01:00Z'),
    ...overrides,
  }) as unknown as IGenerationJobDocumentOf<'image'>;

const call = async (id = JOB_ID) => {
  const { req, res } = createMocks({ method: 'GET', query: { id } });
  Object.assign(req, { user: { id: 'user-1' } });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return { status: res._getStatusCode(), body: res._getJSONData() as Record<string, unknown> };
};

describe('GET /api/image-jobs/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sign.mockResolvedValue({ availability: 'ready', url: 'https://signed.example/img.png' });
  });

  it('looks the job up as the caller own image job', async () => {
    mocks.findOwnGenerationJob.mockResolvedValue(job());
    await call();
    expect(mocks.findOwnGenerationJob).toHaveBeenCalledWith(JOB_ID, 'user-1', 'image');
  });

  it('returns the image resource in the fixed key order the chat card reads', async () => {
    mocks.findOwnGenerationJob.mockResolvedValue(job());
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(Object.keys(body)).toEqual([
      'id',
      'object',
      'state',
      'model',
      'mode',
      'prompt',
      'group_id',
      'source',
      'error',
      'output',
      'credits',
      'created_at',
      'updated_at',
    ]);
    expect(body).toEqual({
      id: JOB_ID,
      object: 'image_generation',
      state: 'succeeded',
      model: 'gpt-image-2',
      mode: 'generate',
      prompt: 'a red bicycle',
      group_id: 'group-1',
      source: 'agent',
      error: null,
      output: {
        availability: 'ready',
        url: 'https://signed.example/img.png',
        expires_at: expect.any(String),
        content_type: 'image/png',
        file_id: FILE_ID,
      },
      credits: { reserved: 5, settled: 4 },
      created_at: '2026-11-15T00:00:00.000Z',
      updated_at: '2026-11-15T00:01:00.000Z',
    });
  });

  it('renders a failed job error from the fixed image copy, never the stored message', async () => {
    mocks.findOwnGenerationJob.mockResolvedValue(
      job({
        state: 'blocked',
        error: { code: 'content_blocked', message: 'provider wording' },
        payload: { ...job().payload, output: undefined },
      } as Partial<IGenerationJobDocumentOf<'image'>>)
    );
    const { body } = await call();
    expect(body.error).toEqual({
      code: 'content_blocked',
      message: 'The image was declined under the content policy.',
    });
    expect(body.output).toBeNull();
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it('answers 404 for a job the caller cannot see', async () => {
    mocks.findOwnGenerationJob.mockResolvedValue(null);
    const { status } = await call();
    expect(status).toBe(404);
  });
});

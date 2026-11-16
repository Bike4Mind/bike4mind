// @vitest-environment node
/**
 * Route tests for GET /api/image-jobs/[id]. `baseApi` is stubbed (no DB, no auth chain) and the repositories are
 * mocked; the projection and the owner/sharee read check (findReadableGenerationJob) run for real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { IGenerationJobDocumentOf } from '@bike4mind/common';

type Mw = (req: unknown, res: unknown, next: () => void) => unknown;

const mocks = vi.hoisted(() => ({
  findJob: vi.fn(),
  findQuest: vi.fn(),
  findAccessibleSession: vi.fn(),
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
vi.mock('@bike4mind/database', () => ({
  generationJobRepository: { findById: mocks.findJob },
  questRepository: { findById: mocks.findQuest },
  sessionRepository: { shareable: { findAccessibleById: mocks.findAccessibleSession } },
}));
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

const call = async (id = JOB_ID, userId = 'user-1') => {
  const { req, res } = createMocks({ method: 'GET', query: { id } });
  Object.assign(req, { user: { id: userId } });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return { status: res._getStatusCode(), body: res._getJSONData() as Record<string, unknown> };
};

describe('GET /api/image-jobs/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sign.mockResolvedValue({ availability: 'ready', url: 'https://signed.example/img.png' });
  });

  it('serves the requester without a session check', async () => {
    mocks.findJob.mockResolvedValue(job({ questId: 'quest-1' }));
    const { status } = await call();
    expect(status).toBe(200);
    expect(mocks.findJob).toHaveBeenCalledWith(JOB_ID);
    expect(mocks.findAccessibleSession).not.toHaveBeenCalled();
  });

  it("serves a reader of the job's notebook, checked as that user against the quest's session", async () => {
    mocks.findJob.mockResolvedValue(job({ questId: 'quest-1' }));
    mocks.findQuest.mockResolvedValue({ id: 'quest-1', sessionId: 'session-1' });
    mocks.findAccessibleSession.mockResolvedValue({ id: 'session-1' });
    const { status, body } = await call(JOB_ID, 'sharee-1');
    expect(status).toBe(200);
    expect(body.id).toBe(JOB_ID);
    expect(mocks.findQuest).toHaveBeenCalledWith('quest-1');
    expect(mocks.findAccessibleSession).toHaveBeenCalledWith({ id: 'sharee-1' }, 'session-1');
  });

  it('answers 404 to a stranger who cannot read the notebook, or when the job has no notebook', async () => {
    mocks.findJob.mockResolvedValue(job({ questId: 'quest-1' }));
    mocks.findQuest.mockResolvedValue({ id: 'quest-1', sessionId: 'session-1' });
    mocks.findAccessibleSession.mockResolvedValue(null);
    expect((await call(JOB_ID, 'stranger-1')).status).toBe(404);

    mocks.findJob.mockResolvedValue(job());
    mocks.findAccessibleSession.mockClear();
    expect((await call(JOB_ID, 'stranger-1')).status).toBe(404);
    expect(mocks.findAccessibleSession).not.toHaveBeenCalled();
  });

  it('answers 404 for a job of another kind', async () => {
    mocks.findJob.mockResolvedValue({ ...job(), kind: 'video' });
    expect((await call()).status).toBe(404);
  });

  it('returns the image resource in the fixed key order the chat card reads', async () => {
    mocks.findJob.mockResolvedValue(job());
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
    mocks.findJob.mockResolvedValue(
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
    mocks.findJob.mockResolvedValue(null);
    const { status } = await call();
    expect(status).toBe(404);
  });
});

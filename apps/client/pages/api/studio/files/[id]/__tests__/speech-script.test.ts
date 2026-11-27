import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  getHandler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  loadAccessibleFabFile: vi.fn(),
  findById: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    use: () => chain,
    // The rate limiter comes first; the route handler is the last argument.
    get: (...handlers: Array<(req: unknown, res: unknown) => Promise<unknown>>) => {
      h.getHandler = handlers.at(-1)!;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/perUserRateLimit', () => ({ perUserRateLimit: () => vi.fn() }));
vi.mock('@bike4mind/server-utils/middlewares/studioFeatureFlag', () => ({ requireStudioFeature: () => vi.fn() }));
vi.mock('@bike4mind/server-utils/files/loadAccessibleFabFile', () => ({
  loadAccessibleFabFile: h.loadAccessibleFabFile,
}));
vi.mock('@bike4mind/database', () => ({ generationJobRepository: { findById: h.findById } }));

import '@pages/api/studio/files/[id]/speech-script';

const FILE_ID = 'f'.repeat(24);

const getScript = async (id: string) => {
  const { req, res } = createMocks({ method: 'GET', query: { id } });
  Object.assign(req, { user: { id: 'user-1' }, logger: { updateMetadata: vi.fn() } });
  await h.getHandler!(req, res);
  return { status: res._getStatusCode(), body: res._getJSONData() as unknown };
};

beforeEach(() => {
  h.loadAccessibleFabFile.mockReset();
  h.findById.mockReset();
});

describe('GET /api/studio/files/:id/speech-script', () => {
  it('serves the script of the job that made the file, loaded through the file ACL', async () => {
    h.loadAccessibleFabFile.mockResolvedValue({
      id: FILE_ID,
      sourceMetadata: { generation: { generator: 'speech', provider: 'elevenlabs', jobId: 'job1', prompt: 'Hi' } },
    });
    h.findById.mockResolvedValue({
      id: 'job1',
      kind: 'speech',
      payload: {
        request: { text: 'Hi there' },
        output: { fileId: FILE_ID, durationSeconds: 1 },
        wordTimings: [{ text: 'Hi', startMs: 0, endMs: 200 }],
      },
    });

    const { status, body } = await getScript(FILE_ID);

    expect(status).toBe(200);
    expect(body).toEqual({
      script: {
        text: 'Hi there',
        truncated: false,
        wordTimings: [{ text: 'Hi', startMs: 0, endMs: 200 }],
        durationMs: 1000,
      },
    });
    expect(h.loadAccessibleFabFile).toHaveBeenCalledWith(expect.anything(), FILE_ID, { browser: true });
    expect(h.findById).toHaveBeenCalledWith('job1');
  });

  it('answers null for a file that is not generated speech', async () => {
    h.loadAccessibleFabFile.mockResolvedValue({ id: FILE_ID });
    expect(await getScript(FILE_ID)).toEqual({ status: 200, body: { script: null } });
    expect(h.findById).not.toHaveBeenCalled();
  });

  it('is a 404 for an id that is not an object id, without loading anything', async () => {
    expect((await getScript('nope')).status).toBe(404);
    expect(h.loadAccessibleFabFile).not.toHaveBeenCalled();
  });
});

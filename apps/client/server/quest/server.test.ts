import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

// SST Resource - the shared-secret bearer the service checks.
const mockResource = vi.hoisted(() => ({
  SECRET_ENCRYPTION_KEY: { value: 'test-shared-secret' },
}));
vi.mock('sst', () => ({ Resource: mockResource }));

// processQuest is the heavy import chain (DB models, services). Mock it so importing the
// server doesn't drag in the whole world and so we can assert it's invoked on a valid 202.
const mockProcessQuest = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@server/queueHandlers/questProcessor', () => ({ processQuest: mockProcessQuest }));

// questRepository.update - used in the error path; connectDB/mongoose unused by createApp.
const mockQuestUpdate = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
  mongoose: { connection: { readyState: 1 } },
  questRepository: { update: mockQuestUpdate },
}));

// Replace the production schema (25+ fields) with a minimal one so the test can drive the
// 400 (invalid) vs 202 (valid) branches without constructing a full QuestStartBody.
vi.mock('@bike4mind/services', async () => {
  const { z } = await import('zod');
  return {
    QuestStartBodySchema: z.object({
      questId: z.string(),
      sessionId: z.string(),
      userId: z.string(),
      message: z.string().min(1),
    }),
  };
});

vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    debug = vi.fn();
  },
}));

vi.mock('@bike4mind/utils', () => ({ registerProcessErrorHandlers: vi.fn() }));
vi.mock('@server/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://x/%STAGE%', STAGE: 'test' } }));

import { createApp } from './server';

const VALID_BODY = { questId: 'q1', sessionId: 's1', userId: 'u1', message: 'hello' };
const AUTH = `Bearer ${mockResource.SECRET_ENCRYPTION_KEY.value}`;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createApp();
  await new Promise<void>(resolve => {
    server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
});

afterEach(() => {
  vi.clearAllMocks();
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${baseUrl}/process`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('QuestProcessorService /process', () => {
  it('returns 401 when the bearer token is missing', async () => {
    const res = await post(VALID_BODY);
    expect(res.status).toBe(401);
    expect(mockProcessQuest).not.toHaveBeenCalled();
  });

  it('returns 401 when the bearer token is wrong', async () => {
    const res = await post(VALID_BODY, { authorization: 'Bearer nope' });
    expect(res.status).toBe(401);
    expect(mockProcessQuest).not.toHaveBeenCalled();
  });

  it('returns 400 on a malformed payload (and does not process)', async () => {
    const res = await post({ questId: 'q1' }, { authorization: AUTH });
    expect(res.status).toBe(400);
    expect(mockProcessQuest).not.toHaveBeenCalled();
  });

  it('returns 202 and kicks off processing for a valid authorized request', async () => {
    const res = await post(VALID_BODY, { authorization: AUTH });
    expect(res.status).toBe(202);
    const json = (await res.json()) as { accepted: boolean; questId: string };
    expect(json).toMatchObject({ accepted: true, questId: 'q1' });
    expect(mockProcessQuest).toHaveBeenCalledTimes(1);
    expect(mockProcessQuest.mock.calls[0][0]).toMatchObject(VALID_BODY);
  });
});

describe('QuestProcessorService /health', () => {
  it('returns 200 when Mongo is connected', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, readyState: 1 });
  });
});

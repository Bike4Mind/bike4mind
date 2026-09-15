import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { toolRepository } from './ToolModel';

// Booting mongod exceeds the default unit-test budget; see createMongoServer's own guidance.
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

// The payload cannot be typed: the first case is invalid by design, omitting the required
// `llmParams` to pin the rejection this suite exists for.
const create = (data: Record<string, unknown>) => toolRepository.create(data as never);

/**
 * The contract the notebook import depends on. Mongoose applies a subdocument's defaults only when
 * the path is set to a non-nullish value, so omitting `llmParams` fails its `required` check -
 * which is why tool import silently produced no tools.
 */
describe('ToolModel create contract', () => {
  it('rejects a payload with no llmParams', async () => {
    await expect(create({ userId: new mongoose.Types.ObjectId(), name: 'no-params' })).rejects.toThrow(/llmParams/);
  });

  it('applies llmParams defaults and returns a usable id', async () => {
    const created = await create({ userId: new mongoose.Types.ObjectId(), name: 'defaulted', llmParams: {} });

    expect(created.llmParams.model).toBe('gpt-3.5-turbo');
    expect(created.llmParams.temperature).toBe(0.9);
    // `BaseRepository.create` returns `toObject()`, which omits virtuals unless the schema opts in.
    expect(String(created.id)).toMatch(/^[0-9a-f]{24}$/i);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../__test__/createMongoServer';
import ImportHistoryJobModel, { importHistoryJobRepository } from './ImportHistoryJobModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

describe('ImportHistoryJob errorStack', () => {
  it('stores the stack on failure but leaves it out of the reads the API returns', async () => {
    const job = await ImportHistoryJobModel.create({
      userId: 'user-errorstack',
      source: 'OpenAI',
      s3Bucket: 'test-bucket',
      s3Key: 'imports/errorstack.zip',
      fileSize: 1024,
    });
    const id = job._id.toString();

    await importHistoryJobRepository.markFailed(id, {
      message: 'conversations.json not found in archive',
      stack: 'Error: conversations.json not found in archive\n    at /tmp/worker/index.js:1:1',
    });

    const listed = await importHistoryJobRepository.search(
      '',
      { userId: 'user-errorstack' },
      { page: 1, limit: 20 },
      { by: 'createdAt', direction: 'desc' }
    );
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0].errorMessage).toBe('conversations.json not found in archive');
    expect(listed.data[0]).not.toHaveProperty('errorStack');

    const single = await importHistoryJobRepository.findByIdAndUserId(id, 'user-errorstack');
    expect(single?.status).toBe('failed');
    expect(single).not.toHaveProperty('errorStack');

    expect(await importHistoryJobRepository.findByS3Key('imports/errorstack.zip')).not.toHaveProperty('errorStack');

    const stored = await ImportHistoryJobModel.findById(id).select('+errorStack').lean();
    expect(stored?.errorStack).toContain('conversations.json not found in archive');
  });
});

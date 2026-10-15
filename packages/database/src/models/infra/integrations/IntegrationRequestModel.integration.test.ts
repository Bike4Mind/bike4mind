import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { IntegrationRequest, integrationRequestRepository } from './IntegrationRequestModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  // The unique (userId, integrationId) index is what makes a request idempotent under races.
  await IntegrationRequest.createIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

afterEach(async () => {
  await IntegrationRequest.deleteMany({});
});

describe('integrationRequestRepository', () => {
  it('records one row per user and integration, however many times or however concurrently it is asked', async () => {
    await Promise.all([
      integrationRequestRepository.request('u1', 'hubspot', 'org1'),
      integrationRequestRepository.request('u1', 'hubspot', 'org1'),
      integrationRequestRepository.request('u1', 'hubspot'),
    ]);
    await integrationRequestRepository.request('u1', 'hubspot');

    expect(await IntegrationRequest.countDocuments({ userId: 'u1', integrationId: 'hubspot' })).toBe(1);
  });

  it("counts requests per integration across users and lists a user's own", async () => {
    await integrationRequestRepository.request('u1', 'hubspot');
    await integrationRequestRepository.request('u2', 'hubspot');
    await integrationRequestRepository.request('u2', 'gmail');

    expect(await integrationRequestRepository.countsByIntegration()).toEqual({ hubspot: 2, gmail: 1 });
    expect((await integrationRequestRepository.requestedBy('u2')).sort()).toEqual(['gmail', 'hubspot']);
    expect(await integrationRequestRepository.requestedBy('u3')).toEqual([]);
  });

  it("withdraws only the caller's own request", async () => {
    await integrationRequestRepository.request('u1', 'hubspot');
    await integrationRequestRepository.request('u2', 'hubspot');

    await integrationRequestRepository.withdraw('u1', 'hubspot');
    await integrationRequestRepository.withdraw('u1', 'hubspot');

    expect(await integrationRequestRepository.countsByIntegration()).toEqual({ hubspot: 1 });
    expect(await integrationRequestRepository.requestedBy('u2')).toEqual(['hubspot']);
  });

  it('rejects a duplicate row written past the repository', async () => {
    await IntegrationRequest.create({ userId: 'u1', integrationId: 'hubspot' });
    await expect(IntegrationRequest.create({ userId: 'u1', integrationId: 'hubspot' })).rejects.toThrow(/E11000/);
  });
});

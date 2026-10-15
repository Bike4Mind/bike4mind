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

  it("deletes every request a user filed, and only that user's", async () => {
    await integrationRequestRepository.request('u1', 'hubspot');
    await integrationRequestRepository.request('u1', 'gmail');
    await integrationRequestRepository.request('u2', 'hubspot');

    expect(await integrationRequestRepository.deleteAllForUser('u1')).toBe(2);
    expect(await integrationRequestRepository.deleteAllForUser('u1')).toBe(0);
    expect(await integrationRequestRepository.countsByIntegration()).toEqual({ hubspot: 1 });
  });

  it("drops a deleted organization from its members' requests and keeps the requests", async () => {
    await integrationRequestRepository.request('u1', 'hubspot', 'org1');
    await integrationRequestRepository.request('u2', 'hubspot', 'org2');

    expect(await integrationRequestRepository.clearOrganization('org1')).toBe(1);
    expect(await IntegrationRequest.countDocuments({ organizationId: 'org1' })).toBe(0);
    expect(await IntegrationRequest.countDocuments({ organizationId: 'org2' })).toBe(1);
    expect(await integrationRequestRepository.countsByIntegration()).toEqual({ hubspot: 2 });
  });

  it('rejects a duplicate row written past the repository', async () => {
    await IntegrationRequest.create({ userId: 'u1', integrationId: 'hubspot' });
    await expect(IntegrationRequest.create({ userId: 'u1', integrationId: 'hubspot' })).rejects.toThrow(/E11000/);
  });
});

const at = (iso: string) => new Date(iso);

describe('integrationRequestRepository.demandSummary', () => {
  it('totals each integration, counts distinct organizations, and spans first to latest request', async () => {
    await IntegrationRequest.create([
      { userId: 'u1', organizationId: 'org1', integrationId: 'hubspot', createdAt: at('2026-03-01T00:00:00Z') },
      { userId: 'u2', organizationId: 'org1', integrationId: 'hubspot', createdAt: at('2026-03-05T00:00:00Z') },
      { userId: 'u3', organizationId: 'org2', integrationId: 'hubspot', createdAt: at('2026-03-03T00:00:00Z') },
      { userId: 'u4', organizationId: null, integrationId: 'hubspot', createdAt: at('2026-02-20T00:00:00Z') },
      { userId: 'u1', organizationId: 'org1', integrationId: 'gmail', createdAt: at('2026-03-02T00:00:00Z') },
    ]);

    expect(await integrationRequestRepository.demandSummary()).toEqual([
      {
        integrationId: 'hubspot',
        total: 4,
        organizations: 2,
        firstRequestedAt: at('2026-02-20T00:00:00Z'),
        latestRequestedAt: at('2026-03-05T00:00:00Z'),
      },
      {
        integrationId: 'gmail',
        total: 1,
        organizations: 1,
        firstRequestedAt: at('2026-03-02T00:00:00Z'),
        latestRequestedAt: at('2026-03-02T00:00:00Z'),
      },
    ]);
  });

  it('treats a missing organizationId like a null one: counted in the total, not as an organization', async () => {
    await IntegrationRequest.collection.insertMany([
      { userId: 'u1', integrationId: 'box', createdAt: at('2026-03-01T00:00:00Z') },
      { userId: 'u2', integrationId: 'box', organizationId: null, createdAt: at('2026-03-02T00:00:00Z') },
    ]);

    const [row] = await integrationRequestRepository.demandSummary();
    expect(row).toMatchObject({ integrationId: 'box', total: 2, organizations: 0 });
  });

  it('breaks a tie in total by id, and keeps ids that are no longer on the roadmap', async () => {
    await integrationRequestRepository.request('u1', 'zapier');
    await integrationRequestRepository.request('u1', 'github');
    await integrationRequestRepository.request('u1', 'airtable');

    const rows = await integrationRequestRepository.demandSummary();
    expect(rows.map(r => r.integrationId)).toEqual(['airtable', 'github', 'zapier']);
    // The upsert path stamps createdAt, which the summary's time span reads.
    expect(rows.every(r => r.firstRequestedAt instanceof Date)).toBe(true);
  });

  it('is empty with no requests', async () => {
    expect(await integrationRequestRepository.demandSummary()).toEqual([]);
  });
});

describe('integrationRequestRepository.requestersFor', () => {
  const seed = async () => {
    // u2 and u3 share a timestamp, so the _id tiebreak decides their order.
    await IntegrationRequest.create([
      { userId: 'u1', organizationId: 'org1', integrationId: 'hubspot', createdAt: at('2026-03-01T00:00:00Z') },
      { userId: 'u2', organizationId: null, integrationId: 'hubspot', createdAt: at('2026-03-03T00:00:00Z') },
      { userId: 'u3', organizationId: 'org2', integrationId: 'hubspot', createdAt: at('2026-03-03T00:00:00Z') },
      { userId: 'u4', organizationId: 'org1', integrationId: 'hubspot', createdAt: at('2026-03-04T00:00:00Z') },
      { userId: 'u5', organizationId: 'org1', integrationId: 'gmail', createdAt: at('2026-03-05T00:00:00Z') },
    ]);
  };

  it('lists one integration newest first, with only the requester fields', async () => {
    await seed();

    const { items, hasMore } = await integrationRequestRepository.requestersFor('hubspot', { limit: 10 });

    expect(hasMore).toBe(false);
    expect(items.map(i => i.userId)).toEqual(['u4', 'u3', 'u2', 'u1']);
    expect(items[0]).toEqual({
      id: expect.any(String),
      userId: 'u4',
      organizationId: 'org1',
      createdAt: at('2026-03-04T00:00:00Z'),
    });
    expect(items.find(i => i.userId === 'u2')?.organizationId).toBeNull();
  });

  it('pages through every row exactly once across a timestamp tie', async () => {
    await seed();

    const seen: string[] = [];
    let after: { createdAt: Date; id: string } | undefined;
    for (let page = 0; page < 10; page++) {
      const { items, hasMore } = await integrationRequestRepository.requestersFor('hubspot', { limit: 1, after });
      seen.push(...items.map(i => i.userId));
      if (!hasMore) break;
      const last = items[items.length - 1];
      after = { createdAt: last.createdAt, id: last.id };
    }

    expect(seen).toEqual(['u4', 'u3', 'u2', 'u1']);
  });

  it('reports hasMore only when a row lies past the page', async () => {
    await seed();

    expect((await integrationRequestRepository.requestersFor('hubspot', { limit: 3 })).hasMore).toBe(true);
    expect((await integrationRequestRepository.requestersFor('hubspot', { limit: 4 })).hasMore).toBe(false);
    expect(await integrationRequestRepository.requestersFor('linear', { limit: 4 })).toEqual({
      items: [],
      hasMore: false,
    });
  });

  it('walks the integrationId, createdAt, _id index rather than sorting in memory', async () => {
    await seed();

    const plan = await IntegrationRequest.find({ integrationId: 'hubspot' })
      .sort({ createdAt: -1, _id: -1 })
      .limit(2)
      .explain('queryPlanner');
    expect(JSON.stringify(plan)).toContain('integrationId_1_createdAt_-1__id_-1');
    expect(JSON.stringify(plan)).not.toContain('"SORT"');
  });
});

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { MAX_INCIDENT_UPDATES, PUBLIC_INCIDENT_ID_PATTERN, StatusIncidentAdminSchema } from '@bike4mind/common/status';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { StatusIncident } from './StatusIncidentModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

const startedAt = new Date('2026-06-01T12:00:00Z');

const incident = (over: Record<string, unknown> = {}) => ({
  publicId: 'abcdefghij',
  kind: 'incident',
  source: 'admin',
  title: 'Elevated errors',
  status: 'investigating',
  impact: 'minor',
  startedAt,
  createdBy: 'admin-1',
  ...over,
});

const update = (n: number) => ({
  updateId: `u_${n}`,
  at: startedAt,
  status: 'investigating',
  body: `Update ${n}`,
  authorId: 'admin-1',
});

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri(), { autoIndex: false });
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 60000);

afterEach(async () => {
  await StatusIncident.deleteMany({});
});

describe('StatusIncident validation', () => {
  it('stores a document that satisfies the admin schema, with defaults filled in', async () => {
    const saved = await StatusIncident.create(incident());
    const parsed = StatusIncidentAdminSchema.safeParse(saved.toObject({ depopulate: true, versionKey: false }));

    expect(parsed.error).toBeUndefined();
    expect(saved).toMatchObject({
      published: false,
      classification: 'standard',
      version: 1,
      updates: [],
      internalNotes: [],
      components: [],
    });
    expect(saved.createdAt).toBeInstanceOf(Date);
  });

  it('stores nested entries without _id keys, matching the admin schema', async () => {
    await StatusIncident.create(
      incident({
        components: [{ componentKey: 'api', impact: 'degraded' }],
        updates: [{ ...update(1), editHistory: [{ at: startedAt, editorId: 'admin-1', body: 'Earlier text' }] }],
        breakGlass: { journalKeys: ['k1'], actorIds: ['a1'], firstWrittenAt: startedAt },
      })
    );
    const stored = await StatusIncident.findOne({}).lean();
    const parsed = StatusIncidentAdminSchema.safeParse({ ...stored, _id: String(stored?._id) });

    expect(parsed.error).toBeUndefined();
    expect(stored?.updates).toHaveLength(1);
    expect(stored?.components).toHaveLength(1);
    for (const entry of [...(stored?.components ?? []), ...(stored?.updates ?? [])]) {
      expect(entry).not.toHaveProperty('_id');
    }
    expect(stored?.updates[0].editHistory).toHaveLength(1);
    expect(stored?.updates[0].editHistory[0]).not.toHaveProperty('_id');
  });

  it.each(['x_1', 'u_', 'u_has space'])('rejects updateId %s', async updateId => {
    await expect(StatusIncident.create(incident({ updates: [{ ...update(1), updateId }] }))).rejects.toThrow(
      /updateId/
    );
  });

  it.each(['abcdefghi', 'abcdefghijk', 'ABCDEFGHIJ', 'abcdefghi-', 'inc_abcdefg'])(
    'rejects publicId %s',
    async publicId => {
      expect(PUBLIC_INCIDENT_ID_PATTERN.test(publicId)).toBe(false);
      await expect(StatusIncident.create(incident({ publicId }))).rejects.toThrow(/publicId/);
    }
  );

  it('accepts a ten-character lowercase alphanumeric publicId', async () => {
    await expect(StatusIncident.create(incident({ publicId: 'a1b2c3d4e5' }))).resolves.toBeTruthy();
  });

  it('accepts exactly the maximum number of updates and rejects one more', async () => {
    const full = Array.from({ length: MAX_INCIDENT_UPDATES }, (_, i) => update(i));
    await expect(StatusIncident.create(incident({ updates: full }))).resolves.toBeTruthy();

    await expect(
      StatusIncident.create(incident({ publicId: 'zzzzzzzzzz', updates: [...full, update(MAX_INCIDENT_UPDATES)] }))
    ).rejects.toThrow(/updates/);
  });

  it('rejects an unknown kind, status, impact or classification', async () => {
    for (const bad of [{ kind: 'outage' }, { status: 'open' }, { impact: 'huge' }, { classification: 'secret' }]) {
      await expect(StatusIncident.create(incident(bad))).rejects.toThrow();
    }
  });

  it('keeps the break-glass journal keys on the stored document', async () => {
    const saved = await StatusIncident.create(
      incident({ breakGlass: { journalKeys: ['k1'], actorIds: ['a1'], firstWrittenAt: startedAt } })
    );
    expect(saved.breakGlass?.journalKeys).toEqual(['k1']);
  });
});

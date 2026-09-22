import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { DataLakeModel, OrgGoogleDriveConnection } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

// A core migration imported transitively via '@bike4mind/database' need not evaluate SST config,
// but mirror the sibling ensure-*-index tests' guard so this stays robust if that changes.
vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260922000002_backfill-data-lake-origin';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND
// hooks in one place (see MONGO_TEST_TIMEOUT_MS for why 30s is not enough).
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await DataLakeModel.deleteMany({});
  await OrgGoogleDriveConnection.deleteMany({});
});

const lake = (slug: string) =>
  DataLakeModel.create({
    name: slug,
    slug,
    fileTagPrefix: `${slug}:`,
    datalakeTag: `datalake:${slug}`,
    createdByUserId: 'user-1',
    organizationId: 'org-1',
  });

const connection = (lakeId: string, over: Record<string, unknown> = {}) =>
  OrgGoogleDriveConnection.create({
    organizationId: 'org-1',
    authMode: 'oauth',
    driveFolderId: `folder-${lakeId}`,
    targetDataLakeId: lakeId,
    connectedBy: 'user-1',
    connectedAt: new Date(),
    enabled: true,
    status: 'connected',
    ...over,
  });

// `lake()` above persists the schema default ('curated') like any real create today. A
// pre-migration production row predates the `origin` field entirely and has no such key - $unset
// bypasses the model's required-ness to reproduce that exact shape.
const dropOrigin = (lakeId: string) => DataLakeModel.updateOne({ _id: lakeId }, { $unset: { origin: 1 } });

// Real mongod, not mocks: the point of this migration is which lakes a real distinct + updateMany
// roundtrip picks up, including the disabled/broken-credential rows a mocked query shape can't prove.
describe('backfill-data-lake-origin migration (real DB)', () => {
  it('marks a lake with a live connection connector-fed', async () => {
    const l = await lake('live');
    await connection(l.id);
    await dropOrigin(l.id);
    await migration.up();
    expect((await DataLakeModel.findById(l.id))!.origin).toBe('connector-fed');
  });

  it('marks a lake with NO connection curated', async () => {
    const l = await lake('hand-built');
    await migration.up();
    expect((await DataLakeModel.findById(l.id))!.origin).toBe('curated');
  });

  it('marks a lake whose connection is disabled connector-fed', async () => {
    // enabled:false means the LAKE is archived or soft-deleted, not that the connector was turned
    // off. Filtering it out here would strip protection from a lake that resumes ingesting the
    // moment it is restored.
    const l = await lake('archived');
    await connection(l.id, { enabled: false });
    await dropOrigin(l.id);
    await migration.up();
    expect((await DataLakeModel.findById(l.id))!.origin).toBe('connector-fed');
  });

  it('marks a lake whose connection has broken credentials connector-fed', async () => {
    const l = await lake('broken');
    await connection(l.id, { status: 'credential_error' });
    await dropOrigin(l.id);
    await migration.up();
    expect((await DataLakeModel.findById(l.id))!.origin).toBe('connector-fed');
  });

  it('does not re-promote a lake the owner demoted back to curated', async () => {
    // No dropOrigin here: origin is already the stored 'curated' default, standing in for a
    // deliberate demotion rather than a pre-field document. $exists: false must not match it.
    const l = await lake('demoted');
    await connection(l.id);
    await migration.up();
    expect((await DataLakeModel.findById(l.id))!.origin).toBe('curated');
  });

  it('down() only resets the connection-backed set, not a manual promotion with no connection', async () => {
    const connected = await lake('connected');
    await connection(connected.id);
    await dropOrigin(connected.id);
    await migration.up();
    expect((await DataLakeModel.findById(connected.id))!.origin).toBe('connector-fed');

    const manual = await lake('manual');
    await DataLakeModel.updateOne({ _id: manual.id }, { $set: { origin: 'connector-fed' } });

    await migration.down();
    expect((await DataLakeModel.findById(connected.id))!.origin).toBe('curated');
    expect((await DataLakeModel.findById(manual.id))!.origin).toBe('connector-fed');
  });
});

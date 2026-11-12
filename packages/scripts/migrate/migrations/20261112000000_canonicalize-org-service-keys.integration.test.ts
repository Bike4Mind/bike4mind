import { beforeAll, afterAll, it, expect } from 'vitest';
import { mongoose } from '@bike4mind/database';
import { CreditHolderType } from '@bike4mind/common';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';
import migration from './20261112000000_canonicalize-org-service-keys';

let server: Awaited<ReturnType<typeof createMongoServer>>;
beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
}, MONGO_TEST_TIMEOUT_MS);
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

it(
  'preserves per-key grants and secrets, disables orphaned keys and is idempotent',
  async () => {
    const db = mongoose.connection.db!;
    const org = new mongoose.Types.ObjectId(),
      creator = String(new mongoose.Types.ObjectId());
    const principal = new mongoose.Types.ObjectId();
    await db.collection('organizations').insertOne({ _id: org, userId: creator });
    const grants = [{ resourceType: 'organization', resourceId: String(org), permission: 'compute' }];
    await db
      .collection('users')
      .insertOne({
        _id: principal,
        isSystem: true,
        isAdmin: false,
        orgServiceAccount: { organizationId: String(org), createdByUserId: creator, grants },
      });
    const valid = await db
      .collection('userapikeys')
      .insertOne({
        keyPrefix: 'valid-prefix',
        userId: String(principal),
        serviceAccount: true,
        organizationId: String(org),
        billingOwnerType: CreditHolderType.Organization,
        keyDigest: 'unchanged-digest',
        status: 'active',
      });
    const orphan = await db
      .collection('userapikeys')
      .insertOne({
        keyPrefix: 'orphan-prefix',
        userId: String(new mongoose.Types.ObjectId()),
        serviceAccount: true,
        status: 'active',
      });
    const mismatch = await db
      .collection('userapikeys')
      .insertOne({
        keyPrefix: 'mismatch-prefix',
        userId: String(principal),
        serviceAccount: true,
        organizationId: String(new mongoose.Types.ObjectId()),
        billingOwnerType: CreditHolderType.Organization,
        status: 'active',
      });
    await db.collection('connections').insertOne({ apiKeyId: String(valid.insertedId), endedAt: null });
    await migration.up();
    const migrated = await db.collection('userapikeys').findOne({ _id: valid.insertedId });
    expect(migrated).toMatchObject({ keyDigest: 'unchanged-digest', orgOwned: { createdByUserId: creator, grants } });
    expect(migrated?.serviceAccount).toBeUndefined();
    expect(
      (await db.collection('connections').findOne({ apiKeyId: String(valid.insertedId) }))?.endedAt
    ).toBeInstanceOf(Date);
    expect(migrated?.userId).not.toBe(String(principal));
    expect(await db.collection('users').findOne({ _id: new mongoose.Types.ObjectId(migrated!.userId) })).toMatchObject({
      isSystem: true,
      serviceAccountOrganizationId: String(org),
    });
    expect(await db.collection('userapikeys').findOne({ _id: orphan.insertedId })).toMatchObject({
      status: 'disabled',
    });
    expect(await db.collection('userapikeys').findOne({ _id: mismatch.insertedId })).toMatchObject({
      status: 'disabled',
    });
    expect((await db.collection('users').findOne({ _id: principal }))?.orgServiceAccount).toBeUndefined();
    await migration.up();
    expect(await db.collection('userapikeys').findOne({ _id: valid.insertedId })).toEqual(migrated);
  },
  MONGO_TEST_TIMEOUT_MS
);

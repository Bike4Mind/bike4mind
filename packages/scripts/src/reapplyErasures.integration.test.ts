import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  AdminAuditLogModel,
  AuthEventModel,
  ErasureRecordModel,
  Organization,
  Session,
  User,
  erasureRecordRepository,
  type IErasureRecord,
} from '@bike4mind/database';
import {
  createMongoReplSet,
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../database/src/__test__/createMongoServer';

vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { JWT_SECRET: 'test-jwt-secret' } }));
const effects = vi.hoisted(() => ({
  storage: vi.fn(),
  cancel: vi.fn(),
  billingEvent: vi.fn(),
  email: vi.fn(),
  artifacts: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getGeneratedImageStorage: () => ({ delete: effects.storage, deletePermanently: effects.storage }),
  getPublishedArtifactsStorage: () => ({ deletePrefix: effects.storage, deletePrefixPermanently: effects.storage }),
  getFilesStorage: () => ({
    delete: effects.storage,
    deletePermanently: effects.storage,
    deletePrefix: effects.storage,
    deletePrefixPermanently: effects.storage,
  }),
  getAppFilesStorage: () => ({ delete: effects.storage, deletePermanently: effects.storage }),
}));
vi.mock('@server/services/publish/purgeUserPublishedArtifacts', () => ({
  purgeUserPublishedArtifacts: effects.artifacts,
}));
vi.mock('@bike4mind/server-utils/skillMarket/market', () => ({ withdrawAuthorListings: vi.fn() }));
vi.mock('@server/auth/signupNetworkLimits', () => ({ retainDeletedSignupTraces: vi.fn() }));
vi.mock('@server/analytics/signupEvents', () => ({ emitBillingEvent: effects.billingEvent }));
vi.mock('@server/users/accountDeletionEmail', () => ({ sendAccountDeletionCompleteEmail: effects.email }));
vi.mock('@server/billing/cancelAccountSubscriptions', () => ({
  cancelAccountSubscriptions: effects.cancel,
  readAccountSubscriptionCustomerIds: vi.fn(async () => []),
  SINGLE_USER_CANCEL_BUDGET_MS: 1000,
  NO_SUBSCRIPTIONS_CANCELED: { canceled: [], failed: [] },
}));

import { hardDeleteUser } from '@server/services/hardDeleteUser';
import { erasureIdHash } from '@bike4mind/server-utils/privacy/erasureHash';
import {
  backfillErasureRecords,
  dbNameFromUri,
  assertRecordsNotTarget,
  assertUriDescribable,
  describeFailure,
  describeMongoTarget,
  describeRecordsSource,
  exportErasureRecords,
  parseErasureExport,
  parseRecordsSource,
  reapplyErasures,
  reapplyExitCode,
  recordsFromCluster,
} from './reapplyErasures';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let database: MongoMemoryReplSet;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const raw = (model: { collection: { name: string } }) => mongoose.connection.collection(model.collection.name);

beforeAll(async () => {
  database = await createMongoReplSet();
  await mongoose.connect(database.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});
beforeEach(async () => {
  vi.clearAllMocks();
  effects.cancel.mockResolvedValue({ canceled: [], failed: [] });
  await mongoose.connection.dropDatabase();
});

async function seedAccount() {
  const userId = new mongoose.Types.ObjectId();
  const orgId = new mongoose.Types.ObjectId();
  const insertRows = async () => {
    await raw(User).insertOne({ _id: userId, username: `u-${userId}`, email: `u-${userId}@example.test` });
    await raw(Organization).insertOne({ _id: orgId, name: 'Personal', userId: String(userId), personal: true });
    await raw(Session).insertOne({
      _id: new mongoose.Types.ObjectId(),
      userId: String(userId),
      name: 'chat',
      organizationId: String(orgId),
    });
    await raw(AuthEventModel).insertOne({ userId: String(userId), createdAt: new Date() });
  };
  await insertRows();
  return { id: String(userId), orgId: String(orgId), insertRows };
}
const counts = async () => ({
  users: await raw(User).countDocuments(),
  orgs: await raw(Organization).countDocuments(),
  sessions: await raw(Session).countDocuments(),
  authEvents: await raw(AuthEventModel).countDocuments(),
});
// The self-serve path removes content and the personal org around the shared delete (completeAccountDeletion).
const erase = async (id: string) => {
  await hardDeleteUser(id, { deletedBy: id, initiatedBy: 'self', logger }, users => users.delete(id));
  await raw(Organization).deleteMany({ userId: id });
  await raw(Session).deleteMany({ userId: id });
};
const keep = async (bystander: { id: string; orgId: string }) => ({
  user: await raw(User).countDocuments({ _id: new mongoose.Types.ObjectId(bystander.id) }),
  org: await raw(Organization).countDocuments({ _id: new mongoose.Types.ObjectId(bystander.orgId) }),
  session: await raw(Session).countDocuments({ userId: bystander.id }),
  authEvents: await raw(AuthEventModel).countDocuments({ userId: bystander.id }),
});
const allRecords = async (): Promise<IErasureRecord[]> => {
  const out: IErasureRecord[] = [];
  for await (const r of erasureRecordRepository.cursor()) out.push(r);
  return out;
};
/** The restore: every row of the erased account comes back; the live erasure records are what survived elsewhere. */
const restore = async (insertRows: () => Promise<void>) => {
  await insertRows();
  vi.clearAllMocks();
};

describe('reapplyErasures', () => {
  it('re-erases a restored account, leaves others, sends nothing, and is a no-op the second time', async () => {
    const erased = await seedAccount();
    const bystander = await seedAccount();
    await erase(erased.id);
    const records = await allRecords();
    expect(records).toHaveLength(1);
    await restore(erased.insertRows);
    expect(await counts()).toEqual({ users: 2, orgs: 2, sessions: 2, authEvents: 2 });

    const first = await reapplyErasures({ records, dryRun: false });
    expect(first).toMatchObject({ scanned: 2, matched: 1, reapplied: 1, failed: 0, unmatchableKey: 0 });
    expect(await counts()).toEqual({ users: 1, orgs: 1, sessions: 1, authEvents: 1 });
    expect(await keep(bystander)).toEqual({ user: 1, org: 1, session: 1, authEvents: 1 });
    expect(effects.cancel).not.toHaveBeenCalled();
    expect(effects.billingEvent).not.toHaveBeenCalled();
    expect(effects.email).not.toHaveBeenCalled();

    const second = await reapplyErasures({ records, dryRun: false });
    expect(second).toMatchObject({ scanned: 1, matched: 0, reapplied: 0 });
    expect(await counts()).toEqual({ users: 1, orgs: 1, sessions: 1, authEvents: 1 });
  });

  it('changes nothing in a dry run and prints no raw id', async () => {
    const erased = await seedAccount();
    await erase(erased.id);
    const records = await allRecords();
    await restore(erased.insertRows);
    const lines: string[] = [];
    const result = await reapplyErasures({ records, dryRun: true, log: m => lines.push(m) });
    expect(result).toMatchObject({ matched: 1, reapplied: 0 });
    expect(await counts()).toEqual({ users: 1, orgs: 1, sessions: 1, authEvents: 1 });
    expect(lines.join('\n')).toContain('would re-erase');
    expect(lines.join('\n')).not.toContain(erased.id);
  });

  it('reports records hashed under another key instead of skipping them silently', async () => {
    const erased = await seedAccount();
    await erase(erased.id);
    const [record] = await allRecords();
    await restore(erased.insertRows);
    const result = await reapplyErasures({ records: [{ ...record, keyId: 'other-key' }], dryRun: false });
    expect(result).toMatchObject({ matched: 0, unmatchableKey: 1 });
    expect(await counts()).toEqual({ users: 1, orgs: 1, sessions: 1, authEvents: 1 });
  });

  it('works from records exported before the restore, after the record collection was lost', async () => {
    const erased = await seedAccount();
    await erase(erased.id);
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'erasure-')), 'erasures.json');
    expect(await exportErasureRecords(erasureRecordRepository.cursor(), file)).toBe(1);
    expect(await readFile(file, 'utf8')).not.toContain(erased.id);

    await ErasureRecordModel.deleteMany({}); // the restored database has no record of the erasure
    await restore(erased.insertRows);
    const result = await reapplyErasures({ records: parseErasureExport(await readFile(file, 'utf8')), dryRun: false });
    expect(result).toMatchObject({ matched: 1, reapplied: 1 });
    expect(await counts()).toEqual({ users: 0, orgs: 0, sessions: 0, authEvents: 0 });
    expect(await ErasureRecordModel.countDocuments({ idHash: erasureIdHash(erased.id) })).toBe(1);
    const again = path.join(path.dirname(file), 'again.json');
    expect(await exportErasureRecords(erasureRecordRepository.cursor(), again)).toBe(1);
  });

  it('copies the external records into the target on execute (not on a dry run), so a later export has them', async () => {
    const erased = await seedAccount();
    const other = await seedAccount();
    await erase(erased.id);
    await erase(other.id);
    const records = await allRecords();
    expect(records).toHaveLength(2);
    await ErasureRecordModel.deleteMany({});
    await restore(erased.insertRows); // only one of the two accounts is back; the other's record must still be kept

    await reapplyErasures({ records, dryRun: true });
    expect(await ErasureRecordModel.countDocuments()).toBe(0);

    const result = await reapplyErasures({ records, dryRun: false });
    expect(result).toMatchObject({ matched: 1, reapplied: 1, recordsLoaded: 2, imported: 2 });
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'erasure-')), 'next.json');
    await exportErasureRecords(erasureRecordRepository.cursor(), file);
    const hashes = parseErasureExport(await readFile(file, 'utf8')).map(r => r.idHash);
    expect(hashes.sort()).toEqual(records.map(r => r.idHash).sort());
  });

  it('reads records over a second connection to another cluster and re-erases the right account', async () => {
    const erased = await seedAccount();
    const bystander = await seedAccount();
    await erase(erased.id);
    const records = await allRecords();
    await ErasureRecordModel.deleteMany({});
    await restore(erased.insertRows);

    const oldCluster = await createMongoServer();
    try {
      const uri = oldCluster.getUri();
      const conn = await mongoose.createConnection(uri, { dbName: 'oldstage' }).asPromise();
      await conn.collection(ErasureRecordModel.collection.name).insertMany(records.map(r => ({ ...r })));
      await conn.close();

      const result = await reapplyErasures({ records: recordsFromCluster(uri, 'oldstage'), dryRun: false });
      expect(result).toMatchObject({ recordsLoaded: 1, matched: 1, reapplied: 1, failed: 0 });
      expect(await raw(User).countDocuments({ _id: new mongoose.Types.ObjectId(erased.id) })).toBe(0);
      expect(await keep(bystander)).toEqual({ user: 1, org: 1, session: 1, authEvents: 1 });
      expect(await ErasureRecordModel.countDocuments({ idHash: erasureIdHash(erased.id) })).toBe(1);
      // Wrong database: nothing is read, and the exit code says so.
      const empty = await reapplyErasures({ records: recordsFromCluster(uri, 'test'), dryRun: true });
      expect(empty.recordsLoaded).toBe(0);
      expect(reapplyExitCode(empty)).toBe(1);
      expect(reapplyExitCode(empty, { allowEmpty: true })).toBe(0);
    } finally {
      await oldCluster.stop();
    }
  });

  it('matches an account erased through an upper-case id', async () => {
    const erased = await seedAccount();
    await hardDeleteUser(erased.id.toUpperCase(), { deletedBy: 'admin', initiatedBy: 'admin', logger }, users =>
      users.delete(erased.id.toUpperCase())
    );
    const records = await allRecords();
    expect(records).toHaveLength(1);
    await raw(Organization).deleteMany({ userId: erased.id }); // the admin path leaves content behind
    await raw(Session).deleteMany({ userId: erased.id });
    await restore(erased.insertRows);
    const result = await reapplyErasures({ records, dryRun: false });
    expect(result).toMatchObject({ matched: 1, reapplied: 1 });
  });

  it('counts a failed purge step after the row delete as failed, and prints no raw id for it', async () => {
    const erased = await seedAccount();
    await hardDeleteUser(erased.id, { deletedBy: 'admin', initiatedBy: 'admin', logger }, users =>
      users.delete(erased.id)
    );
    const records = await allRecords();
    await raw(Organization).deleteMany({ userId: erased.id }); // the admin path leaves content behind
    await raw(Session).deleteMany({ userId: erased.id });
    await restore(erased.insertRows);
    // An admin record skips the content purge, so the only caller is purgeDeletedUserData: after the delete.
    effects.artifacts.mockRejectedValueOnce(new Error(`cdn down for ${erased.id}`));
    const lines: string[] = [];
    const result = await reapplyErasures({ records, dryRun: false, log: m => lines.push(m) });
    expect(result).toMatchObject({ matched: 1, reapplied: 0, failed: 1 });
    expect(reapplyExitCode(result)).toBe(1);
    expect(await raw(User).countDocuments({ _id: new mongoose.Types.ObjectId(erased.id) })).toBe(0);
    const out = lines.join('\n');
    expect(out).toContain('purge step(s) failed');
    expect(out).toContain('cdn down');
    expect(out).not.toContain(erased.id);
  });

  it('reports a failure thrown by the re-erasure itself with the id redacted', async () => {
    const erased = await seedAccount();
    await erase(erased.id);
    const records = await allRecords();
    await restore(erased.insertRows);
    const spy = vi.spyOn(Organization, 'deleteMany').mockRejectedValueOnce(new Error(`boom ${erased.id}`));
    const lines: string[] = [];
    try {
      const result = await reapplyErasures({ records, dryRun: false, log: m => lines.push(m) });
      expect(result).toMatchObject({ matched: 1, reapplied: 0, failed: 1 });
      expect(lines.join('\n')).toContain('FAILED');
      expect(lines.join('\n')).not.toContain(erased.id);
    } finally {
      spy.mockRestore();
    }
  });

  it('lists a non-personal organisation left ownerless, by org id', async () => {
    const erased = await seedAccount();
    await erase(erased.id);
    const records = await allRecords();
    await restore(erased.insertRows);
    const team = new mongoose.Types.ObjectId();
    await raw(Organization).insertOne({ _id: team, name: 'Team', userId: erased.id, personal: false, deletedAt: null });
    const result = await reapplyErasures({ records, dryRun: false });
    expect(result.ownerlessOrganizationIds).toEqual([String(team)]);
  });

  it('rejects a malformed export', () => {
    expect(() => parseErasureExport(JSON.stringify([{ idHash: 'x' }]))).toThrow();
  });
});

describe('records source flags', () => {
  it('requires exactly one source and rejects empty, flag-shaped and conflicting values', () => {
    expect(() => parseRecordsSource([])).toThrow(/exactly one/);
    expect(() => parseRecordsSource(['--records-uri', ''])).toThrow(/needs a value/);
    expect(() => parseRecordsSource(['--records-uri'])).toThrow(/needs a value/);
    expect(() => parseRecordsSource(['--records-file', '--execute'])).toThrow(/needs a value/);
    expect(() => parseRecordsSource(['--records-uri', 'mongodb://h/db', '--records-file', 'f.json'])).toThrow(
      /exactly one/
    );
    expect(() => parseRecordsSource(['--from-target', '--records-file', 'f.json'])).toThrow(/exactly one/);
  });

  it('needs a database name on the records uri, from the path or --records-db', () => {
    const atlas = 'mongodb+srv://u:p@cluster0.example.mongodb.net/?retryWrites=true';
    expect(() => parseRecordsSource(['--records-uri', atlas])).toThrow(/no database/);
    expect(parseRecordsSource(['--records-uri', atlas, '--records-db', 'prod'])).toMatchObject({ dbName: 'prod' });
    expect(parseRecordsSource(['--records-uri', 'mongodb://h1,h2/stage?x=1'])).toMatchObject({ dbName: 'stage' });
    expect(parseRecordsSource(['--records-file', 'f.json'])).toEqual({ kind: 'file', file: 'f.json' });
    expect(parseRecordsSource(['--from-target'])).toEqual({ kind: 'target' });
    expect(dbNameFromUri('mongodb://h/')).toBeUndefined();
  });

  it('prints the target without credentials', () => {
    expect(describeMongoTarget('mongodb+srv://user:secret@c0.example.net/prod?x=1')).toBe('c0.example.net/prod');
    expect(describeMongoTarget('mongodb://127.0.0.1:27017')).toBe('127.0.0.1:27017/(no database)');
  });

  it('prints no part of a password holding a raw slash', () => {
    expect(describeMongoTarget('mongodb://admin:ab/cd@db.example:27017/prod')).toBe('(unparseable uri)');
  });

  it('refuses userinfo the driver would quote back', () => {
    for (const uri of [
      'mongodb://USRX/k:PWDY@h1/db',
      'mongodb://USRX#k:PWDY@h1/db',
      'mongodb://USRX[k:PWDY@h1/db',
      'mongodb://USRX]k:PWDY@h1/db',
      'mongodb+srv://USRX/k:PWDY@c0.example.net/db',
      'mongodb://user:PW/D#Y@h1/db',
    ]) {
      expect(describeMongoTarget(uri)).toBe('(unparseable uri)');
      expect(() => assertUriDescribable(uri, 'MONGODB_URI')).toThrow(/^MONGODB_URI could not be parsed/);
    }
  });

  it('names no database for a records uri whose password holds a raw slash', () => {
    const raw = 'mongodb://user:pa/ss@h1:27017,h2:27017/prod?replicaSet=rs0';
    expect(() => parseRecordsSource(['--records-uri', raw])).toThrow(/names no database/);
  });

  it('prints no userinfo when the password holds a raw question mark', () => {
    const target = describeMongoTarget('mongodb://user:pa?ss@h1/prod');
    expect(target).toBe('(unparseable uri)');
    expect(describeMongoTarget('mongodb://admin:s3cr?et@h1/prod')).not.toMatch(/admin|s3cr/);
    expect(describeMongoTarget('mongodb://user:pa?ss@h1:27017,h2/prod?replicaSet=a')).toBe('(unparseable uri)');
    const source = parseRecordsSource(['--records-uri', 'mongodb://user:pa?ss@h1/prod', '--records-db', 'prod']);
    expect(describeRecordsSource(source)).toBe('(unparseable uri)/prod');
  });

  it('prints nothing for userinfo holding a raw @ or a second @', () => {
    for (const uri of [
      'mongodb://user:p@ss?w@h1/prod',
      'mongodb://us@er:pa?ss@h1/prod',
      'mongodb+srv://us@er:se?cret@cluster0.x.mongodb.net/prod',
      'mongodb://user:p@ss@h1/prod',
      'mongodb://user:pw@h1/prod?appName=ops@team',
    ]) {
      expect(describeMongoTarget(uri)).toBe('(unparseable uri)');
    }
    expect(() => parseRecordsSource(['--records-uri', 'mongodb://us@er:p/a?s@h1/prod'])).toThrow(/no database/);
    expect(describeMongoTarget('mongodb://user:p%40ss@h1,h2:27018/prod?replicaSet=rs0')).toBe('h1,h2:27018/prod');
  });

  it('refuses credentials with an empty or port-only host without echoing the uri', () => {
    for (const uri of [
      'mongodb://USRX:PWDY@/db',
      'mongodb://USRX:PWDY@:27017/db',
      'mongodb://USRX:PWDY@',
      'mongodb+srv://USRX:PWDY@/db',
      'mongodb://USRX:PWDY@h1,,h2/db',
      'mongodb://USRX:PWDY@h1,:27017/db',
    ]) {
      expect(describeMongoTarget(uri)).toBe('(unparseable uri)');
      expect(() => assertUriDescribable(uri, 'MONGODB_URI')).toThrow(/^MONGODB_URI could not be parsed/);
    }
    expect(describeMongoTarget('mongodb+srv://user:secret@c0.example.net/prod?x=1')).toBe('c0.example.net/prod');
    expect(describeMongoTarget('mongodb://127.0.0.1:27017')).toBe('127.0.0.1:27017/(no database)');
    expect(describeMongoTarget('mongodb://u:p@[::1]:27017/db')).toBe('[::1]:27017/db');
  });

  it('refuses an unparseable target or records uri without echoing it', () => {
    const target = 'mongodb://h1/prod?appName=ops@team';
    expect(() => assertUriDescribable(target, 'MONGODB_URI')).toThrow(/MONGODB_URI.*%40/);
    expect(() => assertUriDescribable(target, 'MONGODB_URI')).not.toThrow(/ops|team/);
    const records = 'mongodb://user:pw@h1/prod?appName=ops@team';
    expect(() => assertUriDescribable(records, '--records-uri')).toThrow(/--records-uri/);
    try {
      assertUriDescribable(records, '--records-uri');
    } catch (e) {
      expect((e as Error).message).not.toMatch(/user:|pw|h1|prod|appName|team/);
    }
    expect(() => assertUriDescribable('mongodb://u:p@h1/prod', 'MONGODB_URI')).not.toThrow();
  });

  it('prints a fixed message for a driver parse error and the message for others', () => {
    const parse = Object.assign(new Error('Username contains unescaped characters us?er'), { name: 'MongoParseError' });
    const out = describeFailure(parse);
    expect(out).not.toMatch(/us\?er|unescaped/);
    expect(out).toMatch(/percent-encode/);
    expect(describeFailure(new Error('boom'))).toBe('boom');
  });

  it.each([
    ['mongodb://old.example/prod', 'mongodb://OLD.EXAMPLE:27017/prod'],
    ['mongodb://first.example,second.example/prod', 'mongodb://second.example:27017,first.example/prod'],
    ['mongodb://old.example/test', 'mongodb://old.example'],
    ['mongodb://[::1]/prod', 'mongodb://[::1]:27017/prod'],
  ])('refuses equivalent source %s and target %s', (sourceUri, targetUri) => {
    const source = parseRecordsSource(['--records-uri', sourceUri]);
    expect(() => assertRecordsNotTarget(source, targetUri)).toThrow(/--from-target/);
  });

  it.each([
    ['mongodb://old.example:27018/prod', 'mongodb://old.example/prod'],
    ['mongodb://old.example/prod', 'mongodb://old.example/other'],
    ['mongodb://old.example/prod', 'mongodb://new.example/prod'],
  ])('allows distinct source %s and target %s', (sourceUri, targetUri) => {
    const source = parseRecordsSource(['--records-uri', sourceUri]);
    expect(() => assertRecordsNotTarget(source, targetUri)).not.toThrow();
  });

  it('prints the records source and refuses one equal to the target', () => {
    const uri = parseRecordsSource(['--records-uri', 'mongodb://u:p@old.example:27017/prod?x=1']);
    expect(describeRecordsSource(uri)).toBe('old.example:27017/prod');
    expect(describeRecordsSource({ kind: 'file', file: 'e.json' })).toBe('file e.json');
    expect(() => assertRecordsNotTarget(uri, 'mongodb://u:p@old.example:27017/prod')).toThrow(/--from-target/);
    expect(() => assertRecordsNotTarget(uri, 'mongodb://new.example:27017/prod')).not.toThrow();
    expect(() => assertRecordsNotTarget(uri, 'mongodb://old.example:27017/other')).not.toThrow();
  });
});

describe('backfillErasureRecords', () => {
  const audit = (action: string, targetId: string) =>
    raw(AdminAuditLogModel).insertOne({
      action,
      occurredAt: new Date('2026-03-01T00:00:00Z'),
      target: { kind: 'user', id: targetId, displayName: 'x' },
    });

  it('records erased targets by action, skips existing users, and creates no duplicates', async () => {
    const live = await seedAccount();
    const selfGone = String(new mongoose.Types.ObjectId());
    const adminGone = String(new mongoose.Types.ObjectId());
    await audit('user.deletion.completed', selfGone);
    await audit('user.deleted', adminGone);
    await audit('user.deleted', live.id);
    await audit('user.deleted', adminGone);

    expect(await backfillErasureRecords({ dryRun: true })).toEqual({ candidates: 2, created: 0 });
    expect(await ErasureRecordModel.countDocuments()).toBe(0);

    expect(await backfillErasureRecords({ dryRun: false })).toEqual({ candidates: 2, created: 2 });
    const byHash = new Map((await allRecords()).map(r => [r.idHash, r]));
    expect(byHash.get(erasureIdHash(selfGone))?.initiatedBy).toBe('self');
    expect(byHash.get(erasureIdHash(adminGone))?.initiatedBy).toBe('admin');
    expect(byHash.has(erasureIdHash(live.id))).toBe(false);

    expect(await backfillErasureRecords({ dryRun: false })).toEqual({ candidates: 2, created: 0 });
    expect(await ErasureRecordModel.countDocuments()).toBe(2);
  });
});

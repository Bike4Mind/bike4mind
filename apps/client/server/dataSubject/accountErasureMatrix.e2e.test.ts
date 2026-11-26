import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_ERASURE_COMPLETED_ACTION } from '@bike4mind/common';
import { adminAuditLogRepository, mongoose } from '@bike4mind/database';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { erasureIdHash } from '@bike4mind/server-utils/privacy/erasureHash';
import { DELETED_USER_ID, DELETED_USER_NAME } from '@bike4mind/server-utils/dataSubject/placeholder';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { setPath, valuesAt } from '@bike4mind/server-utils/dataSubject/documentPaths';
import { erasureRegistry } from '@bike4mind/server-utils/dataSubject/erasureRegistry';
import { DATA_HOLDER_REGISTRY } from '@bike4mind/server-utils/dataSubject/registry/index';
import { SubjectErasurePlan } from '@bike4mind/server-utils/dataSubject/subjectErasurePlan';
import type { UserReference } from '@bike4mind/server-utils/dataSubject/types';

type Outcome = 'deleted' | 'anonymized' | 'retained';

vi.mock('sst', () => ({
  Resource: new Proxy({} as Record<string, unknown>, {
    get: (_, key) => ({ value: `test-${String(key)}`, name: `test-${String(key)}` }),
  }),
}));

const effects = vi.hoisted(() => ({
  deleteObject: vi.fn(),
  deletePrefix: vi.fn(),
  sendToQueue: vi.fn(),
  sendCompleteEmail: vi.fn(),
  stripe: {
    retrieve: vi.fn(),
    update: vi.fn(),
    listPaymentMethods: vi.fn(),
    detach: vi.fn(),
    listTaxIds: vi.fn(),
    deleteTaxId: vi.fn(),
    del: vi.fn(),
    listSubscriptions: vi.fn(),
    cancelSubscription: vi.fn(),
  },
}));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => {
  const bucket = {
    delete: effects.deleteObject,
    deletePermanently: effects.deleteObject,
    deletePrefix: effects.deletePrefix,
    deletePrefixPermanently: effects.deletePrefix,
  };
  return {
    getGeneratedImageStorage: () => bucket,
    getPublishedArtifactsStorage: () => bucket,
    getFilesStorage: () => bucket,
    getAppFilesStorage: () => bucket,
  };
});
// purgeImportArchives builds its own S3Storage for the history-import bucket.
vi.mock('@bike4mind/fab-pipeline', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/fab-pipeline')>();
  class FakeS3Storage {
    deletePermanently = effects.deleteObject;
    deletePrefixPermanently = effects.deletePrefix;
  }
  return { ...actual, S3Storage: FakeS3Storage };
});
vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({
  isStripeConfigured: () => true,
  stripe: {
    customers: {
      retrieve: effects.stripe.retrieve,
      update: effects.stripe.update,
      del: effects.stripe.del,
      listPaymentMethods: effects.stripe.listPaymentMethods,
      listTaxIds: effects.stripe.listTaxIds,
      deleteTaxId: effects.stripe.deleteTaxId,
    },
    paymentMethods: { detach: effects.stripe.detach },
    subscriptions: { list: effects.stripe.listSubscriptions, cancel: effects.stripe.cancelSubscription },
  },
}));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ sendToQueue: effects.sendToQueue }));
vi.mock('@bike4mind/server-utils/utils/dlqRegistry', () => ({ getSourceQueueUrl: (name: string) => `queue:${name}` }));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: vi.fn() }));
vi.mock('@bike4mind/server-utils/integrations/stripe/dunning', () => ({
  voidOpenSubscriptionInvoices: vi.fn(async () => ({ voided: [], failed: [] })),
}));
vi.mock('@bike4mind/server-utils/services/cdn/invalidateRouterCdn', async importActual => ({
  ...(await importActual<typeof import('@bike4mind/server-utils/services/cdn/invalidateRouterCdn')>()),
  createCdnInvalidationBatch: () => ({ add: vi.fn(), flush: vi.fn() }),
}));
vi.mock('@bike4mind/server-utils/services/publish/purgeUserPublishedArtifacts', () => ({
  purgeUserPublishedArtifacts: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/skillMarket/market', () => ({ withdrawAuthorListings: vi.fn() }));
vi.mock('@bike4mind/server-utils/auth/signupNetworkLimits', () => ({ retainDeletedSignupTraces: vi.fn() }));
vi.mock('@bike4mind/server-utils/analytics/signupEvents', () => ({ emitBillingEvent: vi.fn() }));
vi.mock('@bike4mind/server-utils/users/accountDeletionEmail', () => ({
  sendAccountDeletionCompleteEmail: effects.sendCompleteEmail,
}));
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/services')>();
  return {
    ...actual,
    authSessionService: { ...actual.authSessionService, endRealtimeConnections: vi.fn() },
  };
});

import { completeAccountDeletion } from '@bike4mind/server-utils/users/completeAccountDeletion';
import { deleteUserAsAdmin } from '@server/admin/deleteUserAsAdmin';
import type { Request } from 'express';
import { z } from 'zod';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

type Doc = Record<string, unknown>;
const ObjectId = mongoose.Types.ObjectId;
const raw = (model: string) => mongoose.model(model).collection;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn(), debug: vi.fn() };

// A path the schema declares, looked up longest-prefix first so `users.userId` finds `users`.
function schemaPathFor(model: string, segments: readonly string[]) {
  const schema = mongoose.model(model).schema;
  for (let split = segments.length; split > 0; split--) {
    const type = schema.path(segments.slice(0, split).join('.'));
    if (type) return { type, split };
  }
  return null;
}

type SchemaType = NonNullable<ReturnType<typeof schemaPathFor>>['type'] & {
  schema?: mongoose.Schema;
  caster?: { instance?: string };
};

const castLeaf = (instance: string | undefined, value: string) =>
  instance === 'ObjectId' && ObjectId.isValid(value) && /^[0-9a-f]{24}$/i.test(value) ? new ObjectId(value) : value;

/** The document fragment that puts `leaf` at `segments`, wrapping in arrays where the schema has them. */
function build(model: string, schema: mongoose.Schema, segments: readonly string[], leaf: string): Doc {
  let found: { type: SchemaType; split: number } | null = null;
  // Shortest prefix first: Mongoose also resolves `users.userId` as a positional leaf, which hides the array.
  for (let split = 1; split <= segments.length; split++) {
    const type = schema.path(segments.slice(0, split).join('.')) as SchemaType | undefined;
    if (type) {
      found = { type, split };
      break;
    }
  }
  if (!found) throw new Error(`${model}: schema does not declare ${segments.join('.')}`);
  const { type, split } = found;
  const rest = segments.slice(split);
  const isArray = type.instance === 'Array';
  let inner: unknown;
  if (type.schema) inner = build(model, type.schema, rest, leaf);
  else if (rest.length > 0) inner = rest.reduceRight<unknown>((value, key) => ({ [key]: value }), leaf);
  else inner = castLeaf(isArray ? type.caster?.instance : type.instance, leaf);
  const out: Doc = {};
  setPath(out, segments.slice(0, split).join('.'), isArray ? [inner] : inner);
  return out;
}

/** One raw document that satisfies `reference` for the subject, with the fields a filter on it needs. */
function documentFor(model: string, reference: UserReference, subject: { userId: string; email: string }): Doc {
  const value = reference.matchBy === 'email' ? subject.email : subject.userId;
  const doc = build(model, mongoose.model(model).schema, reference.path.split('.'), value);
  for (const [key, wanted] of Object.entries(reference.where ?? {})) setPath(doc, key, wanted);
  // Personal rows store a null organization (see `personalFilter`); any other reference on a model that
  // splits personal from team rows must sit in a team organization, or it would be a personal row too.
  const holder = DATA_HOLDER_REGISTRY[model];
  const splitsByScope = 'references' in holder && holder.references.some(other => other.scope === 'personal');
  if (reference.scope === 'personal') doc.organizationId = null;
  else if (splitsByScope) doc.organizationId = `seed-org-${model}`;
  return doc;
}

// Fields the purge reads that no registry reference names: a pending moderation scan makes it wait.
// A default must not satisfy a sibling reference's `where` (a `tier: 'user'` or `dek: null` row would
// match that reference too), or the row's outcome stops being the one its own reference names.
const SEED_DEFAULTS: Record<string, Doc> = {
  FabFile: { moderationStatus: 'clean' },
  AppFile: { path: 'seed/app-file.png' },
  PublishedArtifact: {
    publicId: 'seedpublic',
    tier: 'organization',
    scopeId: 'seedscope',
    slug: 'seedslug',
    source: { kind: 'reply' },
  },
  MemoryPrincipalKey: { dek: 'seed-dek' },
  // A row without an owner type is read as personal; the anonymized reference is a surviving org's.
  UsageEvent: { ownerType: 'Organization', ownerId: 'seed-surviving-org' },
  DataLake: { datalakeTag: 'seed-lake', createdByUserId: 'seed-other-creator' },
  DataLakeAccessGrant: { principalType: 'user', role: 'owner', dataLakeId: '0123456789abcdef01234567' },
  ImportHistoryJob: { s3Bucket: 'test-historyImportBucket', s3Key: 'seed/archive.zip' },
};

// What the registry says each action does to a row naming the person; the matrix expectations come from
// here and from the seeded shape, never from the plan under test.
const OUTCOME_OF_ACTION: Record<UserReference['action'], Outcome> = {
  deleteDocument: 'deleted',
  retain: 'retained',
  anonymize: 'anonymized',
  pullFromArray: 'anonymized',
};

/** A `viaParent` child records the unique parent it sits under; its other rows are holder rows. */
type Seeded = {
  model: string;
  id: unknown;
  reference: string;
  /** The registry reference that seeded this row; absent for a child. */
  ref?: UserReference;
  /** What the registry action on the seeding reference does to this row; absent for a child. */
  outcome?: Outcome;
  under?: { parent: string; parentId: string; deleteWhenParentAnonymized: boolean };
};

/** Inserts one document per registry reference, then one child per `viaParent` entry. */
async function seedFromRegistry(subject: { userId: string; email: string }): Promise<Seeded[]> {
  const seeded: Seeded[] = [];
  const parentDocs = new Map<string, Doc[]>();
  let uniqueKey = 0;
  const insert = async (
    model: string,
    doc: Doc,
    reference: string,
    ref?: UserReference,
    outcome?: Outcome,
    under?: Seeded['under']
  ) => {
    const _id = (doc._id as mongoose.Types.ObjectId | undefined) ?? new ObjectId();
    await raw(model).insertOne({ ...SEED_DEFAULTS[model], ...doc, _id, createdAt: new Date(), updatedAt: new Date() });
    seeded.push({ model, id: _id, reference, ref, outcome, under });
    parentDocs.set(model, [...(parentDocs.get(model) ?? []), { ...doc, _id }]);
  };
  const parentKeys = new Map<string, Set<string>>();
  for (const holder of Object.values(DATA_HOLDER_REGISTRY)) {
    if (holder.kind === 'viaParent') {
      const keys = parentKeys.get(holder.parent) ?? new Set<string>();
      keys.add(holder.parentKey ?? '_id');
      parentKeys.set(holder.parent, keys);
    }
  }
  const withParentKeys = (model: string, doc: Doc): Doc => {
    for (const key of parentKeys.get(model) ?? []) {
      if (key === '_id') continue;
      const found = schemaPathFor(model, key.split('.'));
      setPath(doc, key, found?.type.instance === 'ObjectId' ? new ObjectId() : `seed-${model}-${key}-${uniqueKey++}`);
    }
    return doc;
  };

  for (const [model, holder] of Object.entries(DATA_HOLDER_REGISTRY)) {
    if (holder.kind === 'subject') {
      // The subject row itself is written by the test; the references are on other users' rows.
      for (const reference of holder.references) {
        await insert(
          model,
          documentFor(model, reference, subject),
          `${reference.path} (other user)`,
          reference,
          OUTCOME_OF_ACTION[reference.action]
        );
      }
    } else if (holder.kind === 'holder') {
      for (const reference of holder.references) {
        await insert(
          model,
          withParentKeys(model, documentFor(model, reference, subject)),
          reference.path,
          reference,
          OUTCOME_OF_ACTION[reference.action]
        );
      }
    }
  }
  for (const [model, holder] of Object.entries(DATA_HOLDER_REGISTRY)) {
    if (holder.kind !== 'viaParent') continue;
    const parents = parentDocs.get(holder.parent) ?? [];
    if (parents.length === 0) throw new Error(`${model}: no seeded parent ${holder.parent}`);
    const key = holder.parentKey ?? '_id';
    for (const parent of parents) {
      const value = valuesAt(parent, key)[0];
      const found = schemaPathFor(model, holder.foreignKey.split('.'));
      const fk = (found?.type as SchemaType | undefined)?.instance;
      const stored = fk === 'ObjectId' ? new ObjectId(String(value)) : String(value);
      await insert(model, { [holder.foreignKey]: stored }, `child of ${holder.parent}`, undefined, undefined, {
        parent: holder.parent,
        parentId: String(parent._id),
        deleteWhenParentAnonymized: holder.deleteWhenParentAnonymized === true,
      });
    }
    for (const reference of holder.attribution ?? []) {
      await insert(
        model,
        documentFor(model, reference, subject),
        `${reference.path} (attribution)`,
        reference,
        'anonymized'
      );
    }
  }
  return seeded;
}

let database: MongoMemoryReplSet;

beforeAll(async () => {
  database = await createMongoReplSet();
  await mongoose.connect(database.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});

const SUBJECT_STRIPE_CUSTOMER = 'cus_subject';
const ORG_STRIPE_CUSTOMER = 'cus_org';

beforeEach(async () => {
  vi.clearAllMocks();
  for (const model of mongoose.modelNames()) await raw(model).deleteMany({});
  effects.deleteObject.mockResolvedValue(undefined);
  effects.deletePrefix.mockResolvedValue(undefined);
  effects.sendCompleteEmail.mockResolvedValue(undefined);
  effects.stripe.retrieve.mockImplementation(async (id: string) => ({
    id,
    metadata: { type: id === ORG_STRIPE_CUSTOMER ? 'Organization' : 'User', stage: 'test', note: 'personal' },
  }));
  effects.stripe.update.mockResolvedValue({});
  effects.stripe.listPaymentMethods.mockResolvedValue({ data: [{ id: 'pm_1' }] });
  effects.stripe.listTaxIds.mockResolvedValue({ data: [{ id: 'txi_1' }] });
  effects.stripe.detach.mockResolvedValue({});
  effects.stripe.deleteTaxId.mockResolvedValue({});
  effects.stripe.listSubscriptions.mockResolvedValue({ data: [{ id: 'sub_1', status: 'active' }] });
  effects.stripe.cancelSubscription.mockResolvedValue({});
});

type Audit = { remaining: { model: string; deleted: number; anonymized: number }[]; unclassified: string[] };

// The purge executor leaves nothing but retained rows, which the audit does not list as remaining.
const EMPTY_AUDIT: Audit = { remaining: [], unclassified: [] };

const PAST = new Date('2026-01-01T00:00:00.000Z');

type Source = 'self' | 'admin' | 'delete';

// An admin Delete is stamped by the request, so it seeds no `deletion`; the purge then runs as the worker would.
async function seedSubject(source: Source, inputCase: 'canonical' | 'uppercase' = 'canonical') {
  const userId = inputCase === 'uppercase' ? new ObjectId('abcdef0123456789abcdef01') : new ObjectId();
  const adminId = new ObjectId();
  const subject = { userId: String(userId), email: 'subject@example.test' };
  await raw('User').insertOne({
    _id: userId,
    email: subject.email,
    username: 'subject',
    stripeCustomerId: SUBJECT_STRIPE_CUSTOMER,
    ...(source !== 'delete' && {
      deletion: {
        requestedAt: PAST,
        scheduledFor: PAST,
        source,
        ...(source === 'admin' ? { requestedBy: String(adminId) } : {}),
      },
    }),
  });
  if (source === 'delete') {
    await raw('User').insertOne({
      _id: adminId,
      name: 'Admin',
      email: 'admin@example.test',
      username: 'admin',
      isAdmin: true,
    });
    const req = {
      user: { id: String(adminId), name: 'Admin', isAdmin: true },
      logger,
      headers: {},
      socket: {},
      url: '/',
    } as unknown as Request;
    await deleteUserAsAdmin(
      req,
      inputCase === 'uppercase' ? subject.userId.toUpperCase() : subject.userId,
      'Confirmed duplicate account'
    );
  }
  // Another account's billing customer: the redaction must never reach it.
  await raw('Organization').insertOne({
    _id: new ObjectId(),
    name: 'Other org',
    userId: String(new ObjectId()),
    stripeCustomerId: ORG_STRIPE_CUSTOMER,
  });
  // The admin Delete's own audit rows name the person and are retained; they are not registry seeds.
  const requestAudit = await raw('AdminAuditLog').countDocuments({ 'target.id': subject.userId });
  const seeded = await seedFromRegistry(subject);
  return { subject, adminId: String(adminId), seeded, requestAudit };
}

// Only these rows may vanish where the registry keeps them: the purge deletes every page the person owns
// (the ownerId reference, any tier) and a ShadowDetection record once its last user is pulled.
const EMPTIED_ROW_DELETED = new Set(['ShadowDetection']);
const isOwnedPage = (model: string, ref?: UserReference) => model === 'PublishedArtifact' && ref?.path === 'ownerId';

/**
 * Walks every seeded row by _id on the raw collection (soft-deleted rows count as present), so an
 * executor that anonymizes what it should delete, or deletes a retained or foreign-owned row, fails.
 */
async function expectSeededOutcomes(subject: { userId: string; email: string }, seeded: Seeded[]) {
  const outcomeOf = new Map(
    seeded.filter(row => row.outcome).map(row => [`${row.model}:${String(row.id)}`, row.outcome!])
  );
  const refOf = new Map(seeded.map(row => [`${row.model}:${String(row.id)}`, row.ref]));
  const violations: string[] = [];
  for (const row of seeded) {
    const label = `${row.model} ${row.reference}`;
    const found = await raw(row.model).findOne({ _id: row.id as mongoose.Types.ObjectId });
    let outcome = row.outcome;
    if (row.under) {
      const parent = outcomeOf.get(`${row.under.parent}:${row.under.parentId}`)!;
      outcome = parent === 'anonymized' ? (row.under.deleteWhenParentAnonymized ? 'deleted' : 'retained') : parent;
    }
    if (outcome === 'deleted' && row.model === 'MemoryPrincipalKey') {
      // The purge crypto-shreds a live key and leaves a tombstone (no dek) as the erasure fence.
      if (found?.dek) violations.push(`${label} still holds a key`);
    } else if (outcome === 'deleted') {
      if (found) violations.push(`${label} should be deleted`);
    } else if (!found) {
      const emptied = row.ref?.action === 'pullFromArray' && EMPTIED_ROW_DELETED.has(row.model);
      const purgedWithParent =
        row.under && isOwnedPage(row.under.parent, refOf.get(`${row.under.parent}:${row.under.parentId}`));
      const stronger = isOwnedPage(row.model, row.ref) || purgedWithParent;
      if (!emptied && !stronger) violations.push(`${label} should remain (${outcome})`);
    } else if (row.ref) {
      const wanted = row.ref.matchBy === 'email' ? subject.email : subject.userId;
      const names = valuesAt(found, row.ref.path).some(value => String(value) === wanted);
      if (names !== (outcome === 'retained'))
        violations.push(`${label} should ${outcome === 'retained' ? 'still' : 'no longer'} name the subject`);
    }
  }
  expect(violations).toEqual([]);
}

const touchedCustomers = () =>
  [effects.stripe.update, effects.stripe.deleteTaxId].flatMap(mock => mock.mock.calls.map(call => String(call[0])));

describe.each([
  { label: 'self', source: 'self', inputCase: 'canonical' },
  { label: 'admin', source: 'admin', inputCase: 'canonical' },
  { label: 'delete', source: 'delete', inputCase: 'canonical' },
  { label: 'delete uppercase ID', source: 'delete', inputCase: 'uppercase' },
] as const)('account erasure matrix, $label path', ({ source, inputCase }) => {
  it('seeds every registry store, then leaves nothing but retained rows', async () => {
    const { subject, adminId, seeded, requestAudit } = await seedSubject(source, inputCase);

    // The plan must match the documents seeded, so a reference it cannot see fails here even when a
    // sibling reference on the same model matches. Expected counts come from the seed: each row's
    // reference action, and a child follows the outcome of the unique parent seeded for it. A child
    // under a merely anonymized parent is the parent's other owner's, so only a registry opt-in counts it.
    const outcomeOf = new Map(
      seeded.filter(row => row.outcome).map(row => [`${row.model}:${String(row.id)}`, row.outcome!])
    );
    const expected: Record<string, Record<Outcome, number>> = { User: { deleted: 1, anonymized: 0, retained: 0 } };
    const bump = (model: string, outcome: Outcome) => {
      expected[model] ??= { deleted: 0, anonymized: 0, retained: 0 };
      expected[model][outcome]++;
    };
    const childrenCounted = new Set<string>();
    for (const row of seeded) {
      if (!row.under) {
        bump(row.model, row.outcome!);
        continue;
      }
      const parent = outcomeOf.get(`${row.under.parent}:${row.under.parentId}`);
      if (!parent) throw new Error(`${row.model}: seeded parent ${row.under.parent} has no outcome`);
      if (parent === 'anonymized' && !row.under.deleteWhenParentAnonymized) continue;
      bump(row.model, parent === 'anonymized' ? 'deleted' : parent);
      childrenCounted.add(row.model);
    }
    if (requestAudit > 0) {
      expected.AdminAuditLog ??= { deleted: 0, anonymized: 0, retained: 0 };
      expected.AdminAuditLog.retained += requestAudit;
    }
    const planned = Object.fromEntries(
      (await new SubjectErasurePlan(subject).collections()).map(({ model, deleted, anonymized, retained }) => [
        model,
        { deleted, anonymized, retained },
      ])
    );
    for (const model of childrenCounted)
      expect(Object.keys(planned), `${model} missing from the plan`).toContain(model);
    expect(planned).toEqual(expected);

    const queuedCall = effects.sendToQueue.mock.calls.find(
      (call: readonly unknown[]) => call[0] === 'queue:accountErasureQueue'
    );
    const purgeUserId =
      source === 'delete' ? z.object({ userId: z.string().min(1) }).parse(queuedCall?.[1]).userId : subject.userId;
    await expect(completeAccountDeletion(purgeUserId, { logger, erasureRegistry })).resolves.toEqual({
      deleted: true,
    });

    expect(await erasureRegistry.audit(subject)).toEqual(EMPTY_AUDIT);
    await expectSeededOutcomes(subject, seeded);
    expect(seeded.some(row => row.model === 'OAuthClientSignIn' && row.outcome === 'deleted')).toBe(true);
    expect(await raw('OAuthClientSignIn').countDocuments({ userId: subject.userId })).toBe(0);
    expect(await raw('User').countDocuments({ _id: new ObjectId(subject.userId) })).toBe(0);

    const records = await raw('ErasureRecord')
      .find({ idHash: erasureIdHash(subject.userId) })
      .toArray();
    expect(records).toHaveLength(1);
    expect(records[0].initiatedBy).toBe(source === 'self' ? 'self' : 'admin');

    const completed = await raw('AdminAuditLog')
      .find({ action: 'user.deletion.completed', 'target.id': subject.userId })
      .toArray();
    expect(completed).toHaveLength(1);
    const checks = await raw('AdminAuditLog')
      .find({ action: ADMIN_ERASURE_COMPLETED_ACTION, 'target.id': subject.userId })
      .toArray();
    if (source !== 'self') {
      expect(checks).toHaveLength(1);
      expect(checks[0].details).toMatchObject({ requestedBy: adminId, unclassified: [] });
      expect(checks[0].details.remaining).toEqual([]);
    } else {
      expect(checks).toHaveLength(0);
    }

    if (source === 'delete') {
      const deleted = await raw('AdminAuditLog')
        .find({ action: 'user.deleted', 'target.id': subject.userId })
        .toArray();
      expect(deleted).toHaveLength(1);
      expect(deleted[0].reason).toBe('Confirmed duplicate account');
      expect(effects.sendToQueue).toHaveBeenCalledWith('queue:accountErasureQueue', { userId: subject.userId });
    }

    expect(effects.deletePrefix).toHaveBeenCalled();
    expect(effects.stripe.update).toHaveBeenCalledWith(
      SUBJECT_STRIPE_CUSTOMER,
      expect.objectContaining({ email: '', name: '' }),
      expect.anything()
    );
    expect(effects.stripe.detach).toHaveBeenCalledWith('pm_1', expect.anything(), expect.anything());
    expect(effects.stripe.cancelSubscription).toHaveBeenCalled();
    expect(new Set(touchedCustomers())).toEqual(new Set([SUBJECT_STRIPE_CUSTOMER]));
    expect(effects.stripe.del).not.toHaveBeenCalled();
  });

  it('resumes after a failed Stripe step and completes once', async () => {
    const { subject, adminId, seeded } = await seedSubject(source, inputCase);
    effects.stripe.update.mockRejectedValueOnce(new Error('stripe unavailable'));

    await expect(completeAccountDeletion(subject.userId, { logger, erasureRegistry })).rejects.toThrow(
      'stripe unavailable'
    );
    const stuck = await raw('User').findOne({ _id: new ObjectId(subject.userId) });
    expect(stuck?.deletion?.purgeStartedAt).toBeInstanceOf(Date);
    expect(await raw('ErasureRecord').countDocuments({})).toBe(0);

    await expect(completeAccountDeletion(subject.userId, { logger, erasureRegistry })).resolves.toEqual({
      deleted: true,
    });
    expect(await erasureRegistry.audit(subject)).toEqual(EMPTY_AUDIT);
    await expectSeededOutcomes(subject, seeded);
    const records = await raw('ErasureRecord')
      .find({ idHash: erasureIdHash(subject.userId) })
      .toArray();
    expect(records).toHaveLength(1);
    expect(records[0].initiatedBy).toBe(source === 'self' ? 'self' : 'admin');
    expect(
      await raw('AdminAuditLog').countDocuments({ action: 'user.deletion.completed', 'target.id': subject.userId })
    ).toBe(1);
    const checks = await raw('AdminAuditLog')
      .find({ action: ADMIN_ERASURE_COMPLETED_ACTION, 'target.id': subject.userId })
      .toArray();
    if (source !== 'self') {
      expect(checks).toHaveLength(1);
      expect(checks[0].details).toMatchObject({ requestedBy: adminId, unclassified: [] });
      expect(checks[0].details.remaining).toEqual([]);
    } else {
      expect(checks).toHaveLength(0);
    }
    expect(effects.stripe.update).toHaveBeenCalledTimes(2);
    expect(effects.stripe.update.mock.calls.map(call => call[0])).toEqual([
      SUBJECT_STRIPE_CUSTOMER,
      SUBJECT_STRIPE_CUSTOMER,
    ]);
  });
});

describe('retired audit history erasure', () => {
  it('anonymizes raw legacy triage audit rows while preserving history and its retention index', async () => {
    const { subject } = await seedSubject('self');
    const db = mongoose.connection.db;
    if (!db) throw new Error('Test database unavailable');
    // Independent of registry enumeration: omitting the holder must not omit the regression input.
    const collectionName = 'liveopstriageconfigauditlogs';
    const collection = db.collection(collectionName);
    await collection.createIndex({ timestamp: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 });
    const legacy = {
      _id: new ObjectId(),
      configId: new ObjectId(),
      configName: 'Historical triage config',
      action: 'update',
      userId: subject.userId,
      userName: 'Legacy subject',
      changes: { enabled: { old: true, new: false } },
      timestamp: new Date(Date.now() - 24 * 60 * 60 * 1000),
    };
    const other = {
      ...legacy,
      _id: new ObjectId(),
      configId: new ObjectId(),
      userId: String(new ObjectId()),
      userName: 'Other admin',
    };
    await collection.insertMany([legacy, other]);

    expect(await completeAccountDeletion(subject.userId, { logger, erasureRegistry })).toMatchObject({ deleted: true });

    const anonymized = { ...legacy, userId: DELETED_USER_ID, userName: DELETED_USER_NAME };
    expect(await collection.findOne({ _id: legacy._id })).toEqual(anonymized);
    expect(await collection.findOne({ _id: other._id })).toEqual(other);
    expect(await collection.countDocuments({ userId: subject.userId })).toBe(0);
    expect(await collection.countDocuments({ userName: legacy.userName })).toBe(0);
    const model = mongoose.models.LiveopsTriageConfigAuditLog;
    expect(model?.collection.collectionName).toBe(collectionName);
    expect(model?.schema.indexes()).toContainEqual([
      { timestamp: 1 },
      expect.objectContaining({ expireAfterSeconds: 365 * 24 * 60 * 60 }),
    ]);
    expect(await collection.indexes()).toContainEqual(
      expect.objectContaining({
        key: { timestamp: 1 },
        expireAfterSeconds: 365 * 24 * 60 * 60,
      })
    );
    expect(await erasureRegistry.audit(subject)).toEqual(EMPTY_AUDIT);
    await completeAccountDeletion(subject.userId, { logger, erasureRegistry });
    expect(await collection.findOne({ _id: legacy._id })).toEqual(anonymized);
  });
});

describe('admin Delete stamp transaction', () => {
  it('stamps nothing and queues nothing when the user.deleted write fails', async () => {
    const userId = new ObjectId();
    const adminId = new ObjectId();
    await raw('User').insertOne({ _id: userId, email: 'subject@example.test', username: 'subject', tokenVersion: 3 });
    await raw('User').insertOne({
      _id: adminId,
      name: 'Admin',
      email: 'admin@example.test',
      username: 'admin',
      isAdmin: true,
    });
    const req = {
      user: { id: String(adminId), name: 'Admin', isAdmin: true },
      logger,
      headers: {},
      socket: {},
      url: '/',
    } as unknown as Request;
    const append = vi.spyOn(adminAuditLogRepository, 'append').mockRejectedValueOnce(new Error('audit down'));

    await expect(deleteUserAsAdmin(req, String(userId), 'Confirmed duplicate account')).rejects.toThrow('audit down');
    append.mockRestore();

    const after = await raw('User').findOne({ _id: userId });
    expect(after?.deletion ?? null).toBeNull();
    expect(after?.tokenVersion).toBe(3);
    expect(effects.sendToQueue).not.toHaveBeenCalled();
  });
});

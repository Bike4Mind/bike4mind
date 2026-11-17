import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_ERASURE_COMPLETED_ACTION } from '@bike4mind/common';
import { mongoose } from '@bike4mind/database';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
// Registered outside the `@bike4mind/database` barrel, so they register only when imported.
import '@bike4mind/server-utils/models/Subscription';
import '@server/models/UserSubscription';
import { erasureIdHash } from '@bike4mind/server-utils/privacy/erasureHash';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { setPath, valuesAt } from './documentPaths';
import { KNOWN_ERASURE_GAPS, type ErasureResidue } from './accountErasureKnownGaps';
import { erasureRegistry } from './erasureRegistry';
import { DATA_HOLDER_REGISTRY } from './registry';
import { SubjectErasurePlan } from './subjectErasurePlan';
import type { UserReference } from './types';

vi.mock('sst', () => ({
  Resource: new Proxy({} as Record<string, unknown>, {
    get: (_, key) => ({ value: `test-${String(key)}`, name: `test-${String(key)}` }),
  }),
}));

const effects = vi.hoisted(() => ({
  deleteObject: vi.fn(),
  deletePrefix: vi.fn(),
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

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

type Doc = Record<string, unknown>;
const ObjectId = mongoose.Types.ObjectId;
const raw = (model: string) => mongoose.model(model).collection;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

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
  // Personal rows store a null organization (see `personalFilter`).
  if (reference.scope === 'personal') doc.organizationId = null;
  return doc;
}

// Fields the purge reads that no registry reference names: a pending moderation scan makes it wait.
const SEED_DEFAULTS: Record<string, Doc> = {
  FabFile: { moderationStatus: 'clean' },
  AppFile: { path: 'seed/app-file.png' },
  PublishedArtifact: {
    publicId: 'seedpublic',
    tier: 'user',
    scopeId: 'seedscope',
    slug: 'seedslug',
    source: { kind: 'reply' },
  },
  DataLake: { datalakeTag: 'seed-lake' },
  DataLakeAccessGrant: { principalType: 'user', role: 'owner', dataLakeId: '0123456789abcdef01234567' },
  ImportHistoryJob: { s3Bucket: 'test-historyImportBucket', s3Key: 'seed/archive.zip' },
};

/** `planned` is false for a child whose parent is only anonymized: it belongs to the parent's other owner. */
type Seeded = { model: string; id: unknown; reference: string; planned: boolean };

/** Inserts one document per registry reference, then one child per `viaParent` entry. */
async function seedFromRegistry(subject: { userId: string; email: string }): Promise<Seeded[]> {
  const seeded: Seeded[] = [];
  const parentDocs = new Map<string, { doc: Doc; erased: boolean }[]>();
  const insert = async (model: string, doc: Doc, reference: string, erased: boolean, planned = true) => {
    const _id = (doc._id as unknown) ?? new ObjectId();
    await raw(model).insertOne({ ...SEED_DEFAULTS[model], ...doc, _id, createdAt: new Date(), updatedAt: new Date() });
    seeded.push({ model, id: _id, reference, planned });
    parentDocs.set(model, [...(parentDocs.get(model) ?? []), { doc: { ...doc, _id }, erased }]);
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
      setPath(doc, key, found?.type.instance === 'ObjectId' ? new ObjectId() : `seed-${model}-${key}`);
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
          reference.action === 'deleteDocument'
        );
      }
    } else if (holder.kind === 'holder') {
      for (const reference of holder.references) {
        await insert(
          model,
          withParentKeys(model, documentFor(model, reference, subject)),
          reference.path,
          reference.action === 'deleteDocument'
        );
      }
    }
  }
  for (const [model, holder] of Object.entries(DATA_HOLDER_REGISTRY)) {
    if (holder.kind !== 'viaParent') continue;
    const parents = parentDocs.get(holder.parent) ?? [];
    if (parents.length === 0) throw new Error(`${model}: no seeded parent ${holder.parent}`);
    const key = holder.parentKey ?? '_id';
    for (const { doc: parent, erased } of parents) {
      const value = valuesAt(parent, key)[0];
      const found = schemaPathFor(model, holder.foreignKey.split('.'));
      const fk = (found?.type as SchemaType | undefined)?.instance;
      const stored = fk === 'ObjectId' ? new ObjectId(String(value)) : String(value);
      const followed = erased || holder.deleteWhenParentAnonymized === true;
      await insert(model, { [holder.foreignKey]: stored }, `child of ${holder.parent}`, followed, followed);
    }
    for (const reference of holder.attribution ?? []) {
      await insert(model, documentFor(model, reference, subject), `${reference.path} (attribution)`, false);
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
const residue = (remaining: Audit['remaining']): Record<string, ErasureResidue> =>
  Object.fromEntries(remaining.map(({ model, deleted, anonymized }) => [model, { deleted, anonymized }]));

// Exact match on model and counts: a holder the purge newly misses fails, and so does a further row left
// on an already-gapped model. A gap that was closed but not removed from the map fails as well.
function expectOnlyKnownGaps(audit: Audit) {
  expect(audit.unclassified).toEqual([]);
  expect(residue(audit.remaining)).toEqual(KNOWN_ERASURE_GAPS);
}

const PAST = new Date('2026-01-01T00:00:00.000Z');

async function seedSubject(source: 'self' | 'admin') {
  const userId = new ObjectId();
  const adminId = new ObjectId();
  const subject = { userId: String(userId), email: 'subject@example.test' };
  await raw('User').insertOne({
    _id: userId,
    email: subject.email,
    username: 'subject',
    stripeCustomerId: SUBJECT_STRIPE_CUSTOMER,
    deletion: {
      requestedAt: PAST,
      scheduledFor: PAST,
      source,
      ...(source === 'admin' ? { requestedBy: String(adminId) } : {}),
    },
  });
  // Another account's billing customer: the redaction must never reach it.
  await raw('Organization').insertOne({
    _id: new ObjectId(),
    name: 'Other org',
    userId: String(new ObjectId()),
    stripeCustomerId: ORG_STRIPE_CUSTOMER,
  });
  const seeded = await seedFromRegistry(subject);
  return { subject, adminId: String(adminId), seeded };
}

const touchedCustomers = () =>
  [effects.stripe.update, effects.stripe.deleteTaxId].flatMap(mock => mock.mock.calls.map(call => String(call[0])));

describe.each(['self', 'admin'] as const)('account erasure matrix, %s path', source => {
  it('seeds every registry store, then leaves nothing but retained rows', async () => {
    const { subject, adminId, seeded } = await seedSubject(source);

    // The plan must match the documents seeded, so a reference it cannot see fails here even when a
    // sibling reference on the same model matches. The subject's own row is the one User row not seeded.
    // A holder matches exactly. A viaParent model is bounded: its children under a merely anonymized
    // parent are the parent's other owner's, so the plan may skip those, but never an erased parent's.
    const before = await new SubjectErasurePlan(subject).collections();
    const planned = Object.fromEntries(before.map(c => [c.model, c.deleted + c.anonymized + c.retained]));
    const total: Record<string, number> = { User: 1 };
    const required: Record<string, number> = { User: 1 };
    for (const { model, planned: mustMatch } of seeded) {
      total[model] = (total[model] ?? 0) + 1;
      required[model] = (required[model] ?? 0) + (mustMatch ? 1 : 0);
    }
    expect(Object.keys(planned).sort()).toEqual(Object.keys(total).sort());
    for (const [model, count] of Object.entries(planned)) {
      const isChild = DATA_HOLDER_REGISTRY[model].kind === 'viaParent';
      expect({
        model,
        count,
        ok: isChild ? count >= required[model] && count <= total[model] : count === total[model],
      }).toEqual({
        model,
        count,
        ok: true,
      });
    }

    await expect(completeAccountDeletion(subject.userId, { logger, erasureRegistry })).resolves.toEqual({
      deleted: true,
    });

    const audit = await erasureRegistry.audit(subject);
    expectOnlyKnownGaps(audit);
    expect(await raw('User').countDocuments({ _id: new ObjectId(subject.userId) })).toBe(0);

    const records = await raw('ErasureRecord')
      .find({ idHash: erasureIdHash(subject.userId) })
      .toArray();
    expect(records).toHaveLength(1);
    expect(records[0].initiatedBy).toBe(source);

    const completed = await raw('AdminAuditLog')
      .find({ action: 'user.deletion.completed', 'target.id': subject.userId })
      .toArray();
    expect(completed).toHaveLength(1);
    const checks = await raw('AdminAuditLog')
      .find({ action: ADMIN_ERASURE_COMPLETED_ACTION, 'target.id': subject.userId })
      .toArray();
    if (source === 'admin') {
      expect(checks).toHaveLength(1);
      expect(checks[0].details).toMatchObject({ requestedBy: adminId, unclassified: [] });
      expect(residue(checks[0].details.remaining as Audit['remaining'])).toEqual(KNOWN_ERASURE_GAPS);
    } else {
      expect(checks).toHaveLength(0);
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
    const { subject } = await seedSubject(source);
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
    expectOnlyKnownGaps(await erasureRegistry.audit(subject));
    const records = await raw('ErasureRecord')
      .find({ idHash: erasureIdHash(subject.userId) })
      .toArray();
    expect(records).toHaveLength(1);
    expect(records[0].initiatedBy).toBe(source);
    expect(
      await raw('AdminAuditLog').countDocuments({ action: 'user.deletion.completed', 'target.id': subject.userId })
    ).toBe(1);
    expect(effects.stripe.update).toHaveBeenCalledTimes(2);
    expect(effects.stripe.update.mock.calls.map(call => call[0])).toEqual([
      SUBJECT_STRIPE_CUSTOMER,
      SUBJECT_STRIPE_CUSTOMER,
    ]);
  });
});

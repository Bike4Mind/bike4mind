import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  Organization,
  OrgAlertNotificationModel,
  User,
  inboxRepository,
  mongoose,
  orgAdminNotificationPrefRepository,
} from '@bike4mind/database';
import { createMongoServer } from '../../../../packages/database/src/__test__/createMongoServer';
import { dispatchOrgAlert, type DispatchOrgAlertInput } from './orgAlertDispatcher';

const { publish } = vi.hoisted(() => ({ publish: vi.fn() }));
vi.mock('../utils/eventBus', () => ({ EmailEvents: { Send: { publish } } }));

const ids = {
  org: new mongoose.Types.ObjectId(),
  owner: new mongoose.Types.ObjectId(),
  optedIn: new mongoose.Types.ObjectId(),
  silent: new mongoose.Types.ObjectId(),
  stale: new mongoose.Types.ObjectId(),
};
const str = (id: mongoose.Types.ObjectId) => id.toHexString();

const alert = (overrides: Partial<DispatchOrgAlertInput> = {}): DispatchOrgAlertInput => ({
  organizationId: str(ids.org),
  kind: 'low_balance',
  scope: 'low:500',
  periodKey: '2026-11',
  title: 'Credits running low',
  message: 'The pool is below 500 credits.',
  ...overrides,
});

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  process.env.APP_URL = 'https://app.example.com';
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await OrgAlertNotificationModel.ensureIndexes();
  publish.mockReset();
  await User.collection.insertMany(
    (['owner', 'optedIn', 'silent', 'stale'] as const).map(key => ({ _id: ids[key], email: `${key}@example.com` }))
  );
  await Organization.collection.insertOne({
    _id: ids.org,
    name: 'Acme',
    personal: false,
    userId: str(ids.owner),
    // `stale` is appointed but has no member row, so it is not a current manager.
    adminUserIds: [str(ids.optedIn), str(ids.silent), str(ids.stale)],
    users: [str(ids.optedIn), str(ids.silent)].map(userId => ({ userId, permissions: ['read'] })),
  });
  await orgAdminNotificationPrefRepository.upsertForUser(str(ids.org), str(ids.optedIn), { low_balance: true });
  await orgAdminNotificationPrefRepository.upsertForUser(str(ids.org), str(ids.stale), { low_balance: true });
});

const inboxFor = async (id: mongoose.Types.ObjectId) => inboxRepository.findByReceiverId(str(id));

describe('dispatchOrgAlert', () => {
  it('notifies the owner and opted-in current managers only', async () => {
    const result = await dispatchOrgAlert(alert());

    expect(result.recipientUserIds.sort()).toEqual([str(ids.owner), str(ids.optedIn)].sort());
    expect(await inboxFor(ids.owner)).toHaveLength(1);
    expect(await inboxFor(ids.optedIn)).toHaveLength(1);
    expect(await inboxFor(ids.silent)).toHaveLength(0);
    expect(await inboxFor(ids.stale)).toHaveLength(0);
    expect(publish.mock.calls.map(([e]) => e.to).sort()).toEqual(['optedIn@example.com', 'owner@example.com']);
    expect((await inboxFor(ids.owner))[0].userId).toBe('SYSTEM');
    expect(publish.mock.calls[0][0].body).toContain(`/organizations/${str(ids.org)}?tab=settings`);
  });

  it('sends nothing for a second dispatch of the same key', async () => {
    await dispatchOrgAlert(alert());
    publish.mockClear();

    const again = await dispatchOrgAlert(alert());

    expect(again.claimed).toBe(false);
    expect(publish).not.toHaveBeenCalled();
    expect(await inboxFor(ids.owner)).toHaveLength(1);
  });

  it('honours an owner opt-out', async () => {
    await orgAdminNotificationPrefRepository.upsertForUser(str(ids.org), str(ids.owner), { low_balance: false });

    const result = await dispatchOrgAlert(alert());

    expect(result.recipientUserIds).toEqual([str(ids.optedIn)]);
  });

  it('skips email but keeps the Inbox entry for excluded recipients', async () => {
    await dispatchOrgAlert(alert({ excludeEmailUserIds: [str(ids.owner)] }));

    expect(publish.mock.calls.map(([e]) => e.to)).toEqual(['optedIn@example.com']);
    expect(await inboxFor(ids.owner)).toHaveLength(1);
  });

  it('releases the claim when every delivery fails, so a later event retries', async () => {
    publish.mockRejectedValue(new Error('bus down'));
    const inboxSpy = vi.spyOn(inboxRepository, 'createInboxMessage').mockRejectedValue(new Error('db down'));

    const failed = await dispatchOrgAlert(alert());
    inboxSpy.mockRestore();
    publish.mockReset();

    expect(failed.delivered).toBe(0);
    expect(await OrgAlertNotificationModel.countDocuments({})).toBe(0);
    expect((await dispatchOrgAlert(alert())).claimed).toBe(true);
  });

  it('keeps the claim on a partial failure', async () => {
    publish.mockRejectedValue(new Error('bus down'));

    const result = await dispatchOrgAlert(alert());

    expect(result.delivered).toBe(2);
    expect(await OrgAlertNotificationModel.countDocuments({})).toBe(1);
  });

  it('does nothing for a personal org', async () => {
    await Organization.collection.updateOne({ _id: ids.org }, { $set: { personal: true } });

    const result = await dispatchOrgAlert(alert());

    expect(result.claimed).toBe(false);
    expect(await OrgAlertNotificationModel.countDocuments({})).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });
});

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
import { dispatchOrgAlert, handleOrgEvent, type DispatchOrgAlertInput } from './orgAlertDispatcher';

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
    expect(publish.mock.calls[0][0].body).toContain(`/organizations/${str(ids.org)}?tab=members`);
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

  it('skips the owner email but keeps their Inbox entry when excludeOwnerEmail is set', async () => {
    await dispatchOrgAlert(alert({ excludeOwnerEmail: true }));

    expect(publish.mock.calls.map(([e]) => e.to)).toEqual(['optedIn@example.com']);
    expect(await inboxFor(ids.owner)).toHaveLength(1);
  });

  it('stores inboxMessage in the Inbox while the email keeps message', async () => {
    await dispatchOrgAlert(alert({ message: 'Sam hit the cap', inboxMessage: 'A member hit the cap' }));

    expect(publish.mock.calls[0][0].body).toContain('Sam hit the cap');
    const [entry] = await inboxFor(ids.owner);
    expect(entry.message).toBe('A member hit the cap');
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

describe('dispatchOrgAlert exclusions', () => {
  it('drops excluded recipients entirely', async () => {
    const result = await dispatchOrgAlert(alert({ excludeRecipientUserIds: [str(ids.optedIn)] }));

    expect(result.recipientUserIds).toEqual([str(ids.owner)]);
    expect(await inboxFor(ids.optedIn)).toHaveLength(0);
  });

  it('keeps the owner Inbox entry but skips their email under excludeOwnerEmail', async () => {
    await dispatchOrgAlert(alert({ excludeOwnerEmail: true }));

    expect(await inboxFor(ids.owner)).toHaveLength(1);
    expect(publish.mock.calls.map(([e]) => e.to)).toEqual(['optedIn@example.com']);
  });
});

describe('handleOrgEvent', () => {
  it('announces a join once, never to the joiner or the admin who added them', async () => {
    await orgAdminNotificationPrefRepository.upsertForUser(str(ids.org), str(ids.optedIn), { member_joined: true });
    await orgAdminNotificationPrefRepository.upsertForUser(str(ids.org), str(ids.silent), { member_joined: true });
    const joined = {
      type: 'member_joined' as const,
      organizationId: str(ids.org),
      userId: str(ids.silent),
      actorUserId: str(ids.owner),
    };

    await handleOrgEvent(joined);
    await handleOrgEvent(joined);

    expect(await inboxFor(ids.optedIn)).toHaveLength(1);
    expect(await inboxFor(ids.owner)).toHaveLength(0);
    expect(await inboxFor(ids.silent)).toHaveLength(0);
    const [claim] = await OrgAlertNotificationModel.find({}).lean();
    expect(claim.periodKey).toBe('once');
  });

  it('gives the owner an Inbox entry but no second email for a failed payment', async () => {
    await orgAdminNotificationPrefRepository.upsertForUser(str(ids.org), str(ids.optedIn), { payment_failed: true });

    await handleOrgEvent({ type: 'payment_failed', organizationId: str(ids.org), invoiceId: 'in_1' });

    expect(await inboxFor(ids.owner)).toHaveLength(1);
    expect(await inboxFor(ids.optedIn)).toHaveLength(1);
    expect(publish.mock.calls.map(([e]) => e.to)).toEqual(['optedIn@example.com']);
  });
});

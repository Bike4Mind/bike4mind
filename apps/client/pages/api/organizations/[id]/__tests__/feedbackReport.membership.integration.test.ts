import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { dayjs } from '@bike4mind/common';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../packages/database/src/__test__/createMongoServer';
import { FeedbackModel, User, Organization } from '@bike4mind/database';
import errorHandler from '@server/middlewares/errorHandler';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * The negative suite for the org feedback report, against a real mongod and - the point of the
 * file - against the REAL stamping path: every row here is written by POST /api/feedback, which
 * derives `Feedback.organizationId` from the author's own `User.organizationId` pointer. Seeding
 * `organizationId` directly would prove the `$in` filter runs while never testing whether the
 * population it filters on is the right one, which is the bug this report was built around.
 *
 * Both arms of the union are therefore load-bearing here and each has a row only it can reach:
 * a lapsed member (ACL row, pointer cleared after writing) and an off-ACL author (pointer only).
 * Drop either arm from findMemberUserIds and a count below goes wrong.
 */

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: unknown, res: unknown) => unknown),
  postHandler: null as null | ((req: unknown, res: unknown) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    use: () => chain,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    post: (fn: any) => {
      mockRefs.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('@server/integrations/slack/slack', () => ({
  postFeedbackToSlack: vi.fn().mockResolvedValue({ outcome: 'skipped', reason: 'disabled' }),
}));

vi.mock('@server/utils/eventBus', () => ({
  EmailEvents: { Send: { publish: vi.fn().mockResolvedValue(undefined) } },
}));

vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  return {
    ...actual,
    getSettingsMap: vi.fn().mockResolvedValue({}),
    // Both delivery channels off: this suite's concern is scoping, not notification.
    getSettingsValue: vi.fn(() => undefined),
  };
});

type Handler = (req: unknown, res: unknown) => unknown;

let createFeedback: Handler;
let reportHandler: Handler;
let itemsHandler: Handler;
let itemHandler: Handler;
let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());

  // Order matters: each import overwrites the captured handler, so grab it before the next one.
  await import('../../../feedback/index');
  createFeedback = mockRefs.postHandler!;
  await import('../feedback-report');
  reportHandler = mockRefs.getHandler!;
  await import('../feedback-report/items');
  itemsHandler = mockRefs.getHandler!;
  await import('../feedback-report/[feedbackId]');
  itemHandler = mockRefs.getHandler!;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

afterEach(async () => {
  await mongoose.connection.dropDatabase();
  vi.clearAllMocks();
});

const stubLogger = () => {
  const logger: Record<string, unknown> = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  logger.withMetadata = vi.fn(() => logger);
  return logger;
};

const run = async (handler: Handler, req: unknown, res: unknown) => {
  try {
    await handler(req, res);
  } catch (error) {
    errorHandler(error, req as Parameters<typeof errorHandler>[1], res as Parameters<typeof errorHandler>[2]);
  }
  return res as ReturnType<typeof createMocks>['res'];
};

interface Actor {
  id: string;
  username: string;
  email: string;
}

async function makeUser(prefix: string, organizationId?: mongoose.Types.ObjectId): Promise<Actor> {
  const user = await User.create({
    username: `${prefix}-user`,
    name: `${prefix} User`,
    email: `${prefix}@example.com`,
    ...(organizationId ? { organizationId } : {}),
  });
  return { id: user.id, username: user.username as string, email: user.email as string };
}

/** Writes one feedback row through the real create route, and returns the row it produced. */
async function submitFeedback(actor: Actor, content: string) {
  const { req, res } = createMocks({
    method: 'POST',
    body: { userId: actor.id, content, tags: [], username: actor.username, userEmail: actor.email },
  });
  (req as unknown as { isAuthenticated: () => boolean }).isAuthenticated = () => true;
  (req as unknown as { user: Actor }).user = actor;
  (req as unknown as { ability: { can: () => boolean } }).ability = { can: () => true };
  (req as unknown as { logger: unknown }).logger = stubLogger();
  (req as unknown as { requestId: string }).requestId = 'test-request-id';

  await run(createFeedback, req, res);
  expect(res._getStatusCode()).toBe(201);

  const saved = await FeedbackModel.findOne({ userId: actor.id }).sort({ createdAt: -1 }).lean();
  expect(saved).not.toBeNull();
  return saved!;
}

/** Moves a row in time without Mongoose's timestamps plugin overwriting it on the way back out. */
async function backdate(id: unknown, at: Date) {
  await FeedbackModel.collection.updateOne({ _id: id as mongoose.Types.ObjectId }, { $set: { createdAt: at } });
}

const callReport = (handler: Handler, query: Record<string, string>, caller: { id: string; isAdmin?: boolean }) => {
  const { req, res } = createMocks({ method: 'GET', query });
  (req as unknown as { user: unknown }).user = { id: caller.id, isAdmin: !!caller.isAdmin };
  (req as unknown as { logger: unknown }).logger = stubLogger();
  return run(handler, req, res);
};

/**
 * Org A and every population corner it has. `cleared` users wrote their row while pointed at the
 * org and only lost the pointer afterwards, which is how a stamped row outlives its ACL.
 */
async function seedOrgA() {
  const owner = await makeUser('owner');
  const member = await makeUser('member');
  const lapsed = await makeUser('lapsed');
  const unstamped = await makeUser('unstamped');
  const offAcl = await makeUser('off-acl');
  const departed = await makeUser('departed');

  const orgA = await Organization.create({
    name: 'Org A',
    userId: owner.id,
    users: [
      { userId: member.id, permissions: ['read'] },
      { userId: lapsed.id, permissions: ['read'] },
      { userId: unstamped.id, permissions: ['read'] },
    ],
  });

  // Pointers first: the create route reads them at write time, so this is what does the stamping.
  await User.updateMany(
    { _id: { $in: [owner.id, member.id, lapsed.id, offAcl.id, departed.id] } },
    { organizationId: orgA._id }
  );

  const rows = {
    owner: await submitFeedback(owner, 'owner says hello'),
    member: await submitFeedback(member, 'member says hello'),
    lapsed: await submitFeedback(lapsed, 'lapsed says hello'),
    offAcl: await submitFeedback(offAcl, 'off-acl says hello'),
    departed: await submitFeedback(departed, 'departed says hello'),
    unstamped: await submitFeedback(unstamped, 'unstamped says hello'),
  };

  // Both pointers drop AFTER the write, leaving org-stamped rows behind: `lapsed` keeps an ACL row
  // and stays in scope, `departed` keeps nothing and falls out of it.
  await User.updateMany({ _id: { $in: [lapsed.id, departed.id] } }, { $unset: { organizationId: 1 } });

  return { orgA, owner, member, lapsed, unstamped, offAcl, departed, rows };
}

const WIDE = { from: dayjs().subtract(2, 'days').format('YYYY-MM-DD'), to: dayjs().format('YYYY-MM-DD') };

describe('org feedback report - membership population and denials', () => {
  it('counts both arms of the union and no row outside it', async () => {
    const s = await seedOrgA();

    const res = await callReport(reportHandler, { id: String(s.orgA._id), ...WIDE }, s.owner);
    expect(res._getStatusCode()).toBe(200);
    const report = res._getJSONData();

    // owner + member (both populations) + lapsed (ACL arm only) + offAcl (stamp arm only).
    expect(report.totals.count).toBe(4);
    const counted = report.byMember.map((m: { userId: string }) => m.userId).sort();
    expect(counted).toEqual([s.lapsed.id, s.member.id, s.offAcl.id, s.owner.id].sort());

    // Each exclusion asserted on its own, because each is a different way out of scope.
    expect(counted).not.toContain(s.departed.id); // stamped org A, but in neither population
    expect(counted).not.toContain(s.unstamped.id); // in the ACL, but never carried the stamp
    expect(String(s.rows.unstamped.organizationId ?? '')).toBe(''); // the real path left it null
    expect(String(s.rows.departed.organizationId)).toBe(String(s.orgA._id)); // and stamped this one
  });

  it('reports the disagreement between the two populations instead of hiding it', async () => {
    const s = await seedOrgA();

    const res = await callReport(reportHandler, { id: String(s.orgA._id), ...WIDE }, s.owner);
    const { membership } = res._getJSONData();

    expect(membership.memberCount).toBe(5); // owner, member, lapsed, unstamped, offAcl
    expect(membership.aclOnly.map((m: { userId: string }) => m.userId).sort()).toEqual(
      [s.lapsed.id, s.unstamped.id].sort()
    );
    expect(membership.stampOnly.map((m: { userId: string }) => m.userId)).toEqual([s.offAcl.id]);
    expect(membership.aclOnly[0].displayName).toBeTruthy();
  });

  it('keeps a second org out of this report', async () => {
    const s = await seedOrgA();
    const otherOwner = await makeUser('other-owner');
    const orgB = await Organization.create({ name: 'Org B', userId: otherOwner.id });
    await User.findByIdAndUpdate(otherOwner.id, { organizationId: orgB._id });
    const foreign = await submitFeedback(otherOwner, 'other org says hello');
    expect(String(foreign.organizationId)).toBe(String(orgB._id));

    const res = await callReport(reportHandler, { id: String(s.orgA._id), ...WIDE }, s.owner);
    const report = res._getJSONData();
    expect(report.totals.count).toBe(4);
    expect(report.byMember.map((m: { userId: string }) => m.userId)).not.toContain(otherOwner.id);
  });

  it('answers a plain member with a denial, not an empty report', async () => {
    const s = await seedOrgA();

    const res = await callReport(reportHandler, { id: String(s.orgA._id), ...WIDE }, s.member);

    expect(res._getStatusCode()).toBe(404);
    expect(res._getJSONData()).not.toHaveProperty('totals');
  });

  it('answers a caller with no relationship to the org the same way', async () => {
    const s = await seedOrgA();
    const stranger = await makeUser('stranger');

    const res = await callReport(reportHandler, { id: String(s.orgA._id), ...WIDE }, stranger);
    expect(res._getStatusCode()).toBe(404);
  });

  it('honours the date bound at the day boundary', async () => {
    const s = await seedOrgA();
    const from = dayjs().subtract(5, 'days');
    const startOfFrom = from.startOf('day').toDate();

    await backdate(s.rows.member._id, startOfFrom);
    await backdate(s.rows.lapsed._id, new Date(startOfFrom.getTime() - 1));

    const res = await callReport(
      reportHandler,
      { id: String(s.orgA._id), from: from.format('YYYY-MM-DD'), to: dayjs().format('YYYY-MM-DD') },
      s.owner
    );
    const counted = res._getJSONData().byMember.map((m: { userId: string }) => m.userId);

    expect(counted).toContain(s.member.id); // exactly on `from`
    expect(counted).not.toContain(s.lapsed.id); // one millisecond before it
  });
});

describe('org feedback drill-down - verbatim stays out of reach', () => {
  it('gives the owner metadata only for a row in scope', async () => {
    const s = await seedOrgA();

    const res = await callReport(
      itemHandler,
      { id: String(s.orgA._id), feedbackId: String(s.rows.member._id) },
      s.owner
    );

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body.userId).toBe(s.member.id);
    expect(body.contentStored).toBe(true);
    // The row really does carry text; the response is where it stops.
    expect(s.rows.member.contentStored).toBe(true);
    expect(body).not.toHaveProperty('content');
    expect(body).not.toHaveProperty('promptMeta');
    expect(body).not.toHaveProperty('userEmail');
  });

  it('refuses a non-owner even for a row inside their own org', async () => {
    const s = await seedOrgA();

    const res = await callReport(
      itemHandler,
      { id: String(s.orgA._id), feedbackId: String(s.rows.member._id) },
      s.member
    );

    expect(res._getStatusCode()).toBe(404);
  });

  it('refuses the owner every row outside the scoped population, one denial for all of them', async () => {
    const s = await seedOrgA();
    const otherOwner = await makeUser('other-owner');
    const orgB = await Organization.create({ name: 'Org B', userId: otherOwner.id });
    await User.findByIdAndUpdate(otherOwner.id, { organizationId: orgB._id });
    const foreign = await submitFeedback(otherOwner, 'other org says hello');

    for (const id of [s.rows.departed._id, s.rows.unstamped._id, foreign._id]) {
      const res = await callReport(itemHandler, { id: String(s.orgA._id), feedbackId: String(id) }, s.owner);
      expect(res._getStatusCode()).toBe(404);
      // Byte-identical for a foreign stamp, a departed author and an unstamped row alike.
      expect(res._getJSONData()).toMatchObject({ error: 'Feedback not found' });
    }
  });

  it('lists only the scoped rows, with no text on any of them', async () => {
    const s = await seedOrgA();

    const res = await callReport(itemsHandler, { id: String(s.orgA._id), ...WIDE }, s.owner);

    expect(res._getStatusCode()).toBe(200);
    const page = res._getJSONData();
    expect(page.total).toBe(4);
    expect(page.items.map((i: { userId: string }) => i.userId).sort()).toEqual(
      [s.lapsed.id, s.member.id, s.offAcl.id, s.owner.id].sort()
    );
    for (const item of page.items) {
      expect(item).not.toHaveProperty('content');
      expect(item).not.toHaveProperty('promptMeta');
    }
  });
});

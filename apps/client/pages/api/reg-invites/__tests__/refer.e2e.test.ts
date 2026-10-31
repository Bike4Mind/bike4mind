import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMocks } from 'node-mocks-http';
import { User, userRepository } from '../../../../../../packages/database/src/models/auth/UserModel';
import {
  RegistrationInvite,
  registrationInviteRepository,
} from '../../../../../../packages/database/src/models/auth/RegistrationInviteModel';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../packages/database/src/__test__/createMongoServer';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ post: (...handlers: unknown[]) => handlers[handlers.length - 1] }),
}));
vi.mock('@server/auth/assertOutboundActionAllowed', () => ({
  outboundActionGate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/mailer/emailHelpers', () => ({
  getLogoUrl: () => '',
  buildEmailLogoImg: () => '',
}));
vi.mock('@bike4mind/server-utils/integrations/slack/slack', () => ({ postMessageToSlack: vi.fn() }));
vi.mock('@server/utils/eventBus', () => ({ EmailEvents: { Send: { publish: vi.fn() } } }));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: async () => ({}),
  getSettingsValue: (key: string) => key === 'EnableReferralToEmail',
}));
vi.mock('@bike4mind/database', async () => {
  const users = await import('../../../../../../packages/database/src/models/auth/UserModel');
  const invites = await import('../../../../../../packages/database/src/models/auth/RegistrationInviteModel');
  return { ...users, ...invites, adminSettingsRepository: {} };
});

import handler from '../refer';
import { EmailEvents } from '@server/utils/eventBus';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoServer>>;
beforeAll(async () => {
  process.env.APP_URL = 'https://app.test.local';
  server = await createMongoServer();
  await mongoose.connect(server.getUri(), { autoIndex: false });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await RegistrationInvite.deleteMany({});
  await User.deleteMany({});
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

function request(userId: string, emails: string[], staleQuota = 1) {
  const { req, res } = createMocks({ method: 'POST' });
  Object.assign(req, {
    user: { id: userId, emailVerified: true, numReferralsAvailable: staleQuota, regInvites: [] },
    ability: {},
    body: { userName: 'Sender', friendEmail: emails, emailTitle: 'Join', emailBody: 'Welcome' },
  });
  return {
    res,
    run: () =>
      handler(req as unknown as Parameters<typeof handler>[0], res as unknown as Parameters<typeof handler>[1]),
  };
}

it('two concurrent requests sharing the same auth snapshot cannot mint or send beyond quota', async () => {
  const user = await User.create({
    username: 'sender',
    name: 'Sender',
    email: 'sender@example.com',
    numReferralsAvailable: 1,
  });
  const first = request(String(user._id), ['first@example.com']);
  const second = request(String(user._id), ['second@example.com']);
  const results = await Promise.allSettled([first.run(), second.run()]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const rejected = results.find(result => result.status === 'rejected');
  expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({
    message: 'Not enough referrals available',
  });
  expect(await RegistrationInvite.countDocuments()).toBe(1);
  expect(EmailEvents.Send.publish).toHaveBeenCalledTimes(1);
  const invite = await RegistrationInvite.findOne();
  const delivery = vi.mocked(EmailEvents.Send.publish).mock.calls[0][0];
  expect(delivery.to).toBe(invite!.email);
  expect(delivery.body).toContain(`Invite code: <strong>${invite!.code}</strong>`);
  const after = await User.findById(user._id);
  expect(after!.numReferralsAvailable).toBe(0);
  expect(after!.regInvites.map(String)).toEqual([(await RegistrationInvite.findOne())!.id]);
});

it('charges registered addresses uniformly and deduplicates before reserving', async () => {
  const user = await User.create({
    username: 'sender',
    name: 'Sender',
    email: 'sender@example.com',
    numReferralsAvailable: 2,
  });
  await User.create({ username: 'existing', name: 'Existing', email: 'existing@example.com' });
  const call = request(String(user._id), ['new@example.com', 'existing@example.com', 'new@example.com'], 0);
  await call.run();
  expect(call.res._getJSONData()).toMatchObject({
    sent: ['new@example.com', 'existing@example.com'],
    failed: [],
  });
  expect((await User.findById(user._id))!.numReferralsAvailable).toBe(0);
  expect(await RegistrationInvite.countDocuments()).toBe(1);
});

it('refunds only a failed pre-invite lookup so that quota can be reserved again', async () => {
  const user = await User.create({
    username: 'sender',
    name: 'Sender',
    email: 'sender@example.com',
    numReferralsAvailable: 2,
  });
  vi.spyOn(registrationInviteRepository, 'find').mockRejectedValueOnce(new Error('lookup failed'));
  const call = request(String(user._id), ['failed@example.com', 'ok@example.com']);
  await call.run();
  expect(call.res._getJSONData()).toMatchObject({
    sent: ['ok@example.com'],
    failed: ['failed@example.com'],
  });
  expect((await User.findById(user._id))!.numReferralsAvailable).toBe(1);
  expect(await RegistrationInvite.countDocuments()).toBe(1);
  expect(await userRepository.reserveReferrals(String(user._id), 1)).toBe(true);
});

/**
 * Real-Mongo check of the ban-evasion device rule over seeded accounts that reproduce a VPN farm:
 * an account banned one day, a new one the next day from the same uncommon device on a rotated
 * hosting exit, next to genuine look-alikes (an OAuth signup with no device, a mainstream phone that
 * shares a banned account's profile). The database reads, the dedupe claim and the detection write
 * are the live ones; only the config and the assessment step are stubbed.
 *
 * Consumes the built dist (`pnpm turbo:core:build`); integration lane only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { Cache, ShadowDetectionModel, User, loadRecentDeviceLinkAccounts } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { checkDeviceLink, liveDeviceLinkDeps, sweepDeviceLinks, type DeviceLinkDeps } from './deviceLink';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date('2026-11-05T14:00:00Z');
const RARE_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const RARE_DEVICE = { screenResolution: '376x835', devicePixelRatio: 3.25, userAgent: RARE_UA };
const PHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const PHONE_DEVICE = { screenResolution: '390x844', devicePixelRatio: 3, userAgent: PHONE_UA };

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
beforeEach(async () => {
  await Promise.all([User.collection.deleteMany({}), ShadowDetectionModel.deleteMany({}), Cache.deleteMany({})]);
});

type Seed = {
  hoursAgo: number;
  isBanned?: boolean;
  asn: number;
  ip: string;
  datacenter: boolean;
  devices: (typeof RARE_DEVICE)[];
};

async function seed(seedInput: Seed): Promise<string> {
  const _id = new mongoose.Types.ObjectId();
  const createdAt = new Date(NOW.getTime() - seedInput.hoursAgo * HOUR_MS);
  // Raw insert: the rule reads only these fields, and the model's required profile fields are noise here.
  await User.collection.insertOne({
    _id,
    username: `user-${_id.toString()}`,
    email: `${_id.toString()}@example.test`,
    createdAt,
    deletedAt: null,
    isBanned: seedInput.isBanned ?? false,
    signupMeta: { ip: seedInput.ip, asn: seedInput.asn, isDatacenter: seedInput.datacenter },
    loginRecords: seedInput.devices.map(device => ({ ...device, loginTime: createdAt })),
  });
  return _id.toString();
}

function deps(): DeviceLinkDeps & { assessAndContain: ReturnType<typeof vi.fn> } {
  // The logger is only used by the live assessment step, which is stubbed here.
  const live = liveDeviceLinkDeps({} as unknown as Logger);
  return {
    ...live,
    loadConfig: async () => ({ windowHours: 168, commonNetworks: 5 }),
    assessAndContain: vi.fn(async () => ({ assessed: false, contained: false })),
    now: () => NOW,
  };
}

describe('device link rule over seeded accounts', () => {
  it('flags the VPN farm account once and leaves the genuine look-alikes alone', async () => {
    await seed({
      hoursAgo: 28,
      isBanned: true,
      asn: 64501,
      ip: '198.51.100.20',
      datacenter: false,
      devices: [RARE_DEVICE],
    });
    const farm = await seed({ hoursAgo: 1, asn: 13335, ip: '192.0.2.10', datacenter: true, devices: [RARE_DEVICE] });
    // OAuth signup: no sign-in record, so nothing to compare.
    const oauth = await seed({ hoursAgo: 2, asn: 64520, ip: '203.0.113.5', datacenter: false, devices: [] });
    // A mainstream phone: one banned account used it too, but so do signups on five other networks.
    await seed({
      hoursAgo: 30,
      isBanned: true,
      asn: 64530,
      ip: '198.51.100.40',
      datacenter: false,
      devices: [PHONE_DEVICE],
    });
    for (const asn of [64531, 64532, 64533, 64534, 64535]) {
      await seed({ hoursAgo: 200, asn, ip: `203.0.113.${asn - 64500}`, datacenter: false, devices: [PHONE_DEVICE] });
    }
    const phone = await seed({
      hoursAgo: 3,
      asn: 64536,
      ip: '203.0.113.99',
      datacenter: false,
      devices: [PHONE_DEVICE],
    });

    const first = deps();
    const report = await sweepDeviceLinks({ ...first, loadRecent: loadRecentDeviceLinkAccounts });

    expect(report).toMatchObject({ status: 'done', linked: 1, recorded: 1, failed: 0 });
    const detections = await ShadowDetectionModel.find({ detector: 'deviceLinkedToBlocked' }).lean();
    expect(detections.map(detection => detection.userIds)).toEqual([[farm]]);
    expect(first.assessAndContain).toHaveBeenCalledTimes(1);

    expect(await checkDeviceLink(oauth, deps())).toEqual({ status: 'skipped', reason: 'no_device' });
    expect(await checkDeviceLink(phone, deps())).toEqual({ status: 'skipped', reason: 'common_device_only' });

    // A second pass and the signup-time check do not record the farm again; nothing was banned.
    const again = await sweepDeviceLinks({ ...deps(), loadRecent: loadRecentDeviceLinkAccounts });
    expect(again).toMatchObject({ linked: 1, recorded: 0, alreadyRecorded: 1 });
    expect(await checkDeviceLink(farm, deps())).toEqual({ status: 'skipped', reason: 'already_recorded' });
    expect(await ShadowDetectionModel.countDocuments()).toBe(1);
    expect(await User.collection.countDocuments({ isBanned: true })).toBe(2);
  });

  it('does not link the same rare device a month after the ban on an unrelated network', async () => {
    await seed({
      hoursAgo: 30 * 24,
      isBanned: true,
      asn: 64501,
      ip: '198.51.100.20',
      datacenter: false,
      devices: [RARE_DEVICE],
    });
    const later = await seed({ hoursAgo: 1, asn: 64502, ip: '203.0.113.7', datacenter: false, devices: [RARE_DEVICE] });

    expect(await checkDeviceLink(later, deps())).toEqual({ status: 'skipped', reason: 'uncorroborated' });
    expect(await ShadowDetectionModel.countDocuments()).toBe(0);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { setupMongoTest } from '../../__test__/utils';
import { User } from './UserModel';
import { UserApiKey } from './UserApiKeyModel';
import { UsageEvent } from '../billing/UsageEventModel';
import { loadCampaignScanAccounts } from './campaignScanAccounts';

const HOUR = 60 * 60 * 1000;
const since = new Date('2026-11-01T00:00:00Z');
const until = new Date(since.getTime() + 72 * HOUR);
const at = (hours: number) => new Date(since.getTime() + hours * HOUR);
const ja4 = 't13d1516h2_8daaf6152771_02713d6af862';

// Raw inserts: the loader reads stored fields, and the models' required fields are beside the point.
const insertUser = async (hours: number, extra: Record<string, unknown> = {}) => {
  const _id = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id, email: `${_id}@example.com`, createdAt: at(hours), ...extra });
  return _id.toString();
};

describe('loadCampaignScanAccounts', () => {
  setupMongoTest();

  beforeEach(async () => {
    await Promise.all([
      User.deleteMany({}),
      UserApiKey.collection.deleteMany({}),
      UsageEvent.collection.deleteMany({}),
    ]);
  });

  it('reads live accounts in the window with their first lifecycle steps', async () => {
    const scripted = await insertUser(1, {
      emailVerifiedAt: at(1.01),
      signupMeta: { ip: '203.0.113.7', asn: 64500, isDatacenter: true, ja4, userAgent: 'kept out' },
    });
    const bare = await insertUser(2);
    await insertUser(-1);
    await insertUser(73);
    await insertUser(3, { deletedAt: at(4) });
    await UserApiKey.collection.insertMany([
      { userId: scripted, createdAt: at(1.2) },
      { userId: scripted, createdAt: at(1.1) },
    ]);
    await UsageEvent.collection.insertMany([
      { userId: scripted, createdAt: at(1.3) },
      { userId: scripted, createdAt: at(5) },
      { userId: bare, createdAt: at(-2) },
    ]);

    const { rows, truncated } = await loadCampaignScanAccounts({ since, until, limit: 10 });

    expect(truncated).toBe(false);
    expect(rows).toEqual([
      {
        userId: bare,
        email: `${bare}@example.com`,
        createdAt: at(2),
        emailVerifiedAt: null,
        ip: null,
        asn: null,
        isDatacenter: null,
        ja4: null,
        firstApiKeyAt: null,
        firstUsageAt: null,
      },
      {
        userId: scripted,
        email: `${scripted}@example.com`,
        createdAt: at(1),
        emailVerifiedAt: at(1.01),
        ip: '203.0.113.7',
        asn: 64500,
        isDatacenter: true,
        ja4,
        firstApiKeyAt: at(1.1),
        firstUsageAt: at(1.3),
      },
    ]);
  });

  it('keeps the newest accounts when the scan cap is reached and says so', async () => {
    const ids = [];
    for (let hour = 0; hour < 5; hour++) ids.push(await insertUser(hour));

    const { rows, truncated } = await loadCampaignScanAccounts({ since, until, limit: 3 });

    expect(truncated).toBe(true);
    expect(rows.map(row => row.userId)).toEqual([ids[4], ids[3], ids[2]]);
  });

  it('rejects an unbounded scan', async () => {
    await expect(
      loadCampaignScanAccounts({ since, until: new Date(since.getTime() + 15 * 24 * HOUR), limit: 10 })
    ).rejects.toThrow();
    await expect(loadCampaignScanAccounts({ since, until, limit: 50_000 })).rejects.toThrow();
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { CreditHolderType, noCardUnlockTransactionId } from '@bike4mind/common';
import { AdminSettings, Cache, CreditLot, CreditTransaction, PhoneUnlockClaim, User } from '@bike4mind/database';
import { hashPhone, startPhoneUnlock } from './phoneUnlock';
import { runNoCardUnlock } from './runNoCardUnlock';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const { twilioConfig } = vi.hoisted(() => ({
  twilioConfig: { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_VERIFY_SERVICE_SID: 'VA1' } as Record<
    string,
    string | undefined
  >,
}));

vi.mock('@bike4mind/server-utils/utils/config', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/server-utils/utils/config')>();
  return {
    ...actual,
    Config: new Proxy(actual.Config, {
      get: (t, k: string) => (k in twilioConfig ? twilioConfig[k] : Reflect.get(t, k)),
    }),
  };
});

const PHONE_CREDITS = 4;
const NUMBER = '+447700900123';
// getClientIp ignores x-forwarded-for off self-host and drops documentation ranges as private.
const req = (ip = '81.2.69.7') => ({ headers: { 'x-real-ip': ip } });

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await createMongoReplSet();
  await mongoose.connect(replSet.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

type TwilioScript = {
  lineType?: string;
  valid?: boolean;
  approved?: boolean;
  sendStatus?: number;
  sendCode?: number;
  checkStatus?: number;
  checkCode?: number;
  canonical?: string;
};

const twilioFetch = (script: TwilioScript = {}) =>
  vi.fn(async (url: string) => {
    if (url.startsWith('https://lookups.twilio.com/')) {
      const typed = decodeURIComponent(url.split('/PhoneNumbers/')[1].split('?')[0]);
      const body = {
        valid: script.valid ?? true,
        phone_number: script.canonical ?? typed,
        country_code: 'GB',
        line_type_intelligence: { type: script.lineType ?? 'mobile' },
      };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (url.endsWith('/Verifications')) {
      const status = script.sendStatus ?? 201;
      return new Response(JSON.stringify(status < 300 ? { status: 'pending' } : { code: script.sendCode }), { status });
    }
    if (url.endsWith('/VerificationCheck')) {
      if (script.checkStatus) {
        return new Response(JSON.stringify({ code: script.checkCode }), { status: script.checkStatus });
      }
      return new Response(JSON.stringify({ status: script.approved === false ? 'pending' : 'approved' }), {
        status: 200,
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });

let fetchMock: ReturnType<typeof twilioFetch>;

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  await Promise.all(
    [User, CreditTransaction, CreditLot, AdminSettings, Cache, PhoneUnlockClaim].map(model => model.createIndexes())
  );
  const settings: Record<string, unknown> = {
    noCardUnlockEnabled: true,
    noCardUnlockPhoneEnabled: true,
    noCardUnlockPhoneCredits: PHONE_CREDITS,
    noCardUnlockMaxCredits: 15,
  };
  for (const [settingName, settingValue] of Object.entries(settings)) {
    await AdminSettings.create({ settingName, settingValue });
  }
  twilioConfig.TWILIO_ACCOUNT_SID = 'AC1';
  fetchMock = twilioFetch();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const seedUser = async () => {
  const tag = Math.random().toString(36).slice(2, 10);
  const doc = await User.create({
    name: 'Dev',
    username: `dev-${tag}`,
    email: `dev-${tag}@acme-corp.test`,
    password: null,
    hasUsablePassword: false,
    emailVerified: true,
    currentCredits: 0,
  });
  return doc.id as string;
};

// Only Twilio calls cost money; eligibility may also make its own domain lookups.
const twilioCalls = () =>
  fetchMock.mock.calls.filter(([url]) => /^https:\/\/(lookups|verify)\.twilio\.com\//.test(String(url)));
const sentCount = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/Verifications')).length;

describe('phone unlock start + verify', () => {
  it('sends a code, then grants under the per-reason ledger id and stores only a hash of the number', async () => {
    const id = await seedUser();
    expect(await startPhoneUnlock(id, '+44 7700 900123', req())).toEqual({ sent: true, sentTo: NUMBER });
    expect(await runNoCardUnlock('phone_verified', id, { phoneCode: '123456' })).toEqual({
      creditsGranted: PHONE_CREDITS,
      currentCredits: PHONE_CREDITS,
    });
    expect(
      await CreditTransaction.countDocuments({ transactionId: noCardUnlockTransactionId('phone_verified', id) })
    ).toBe(1);
    const claim = await PhoneUnlockClaim.findOne({}).lean();
    expect(claim?.phoneHash).toBe(hashPhone(NUMBER));
    expect(JSON.stringify(claim)).not.toContain('7700900123');
    expect(await Cache.countDocuments({ key: `phone-unlock:pending:${id}` })).toBe(0);
  });

  it.each(['nonFixedVoip', 'fixedVoip', 'landline', 'tollFree'])('refuses a %s line without sending', async type => {
    vi.stubGlobal('fetch', (fetchMock = twilioFetch({ lineType: type })));
    const id = await seedUser();
    expect(await startPhoneUnlock(id, NUMBER, req())).toEqual({ sent: false, refusal: 'phone_line_type' });
    expect(sentCount()).toBe(0);
  });

  it('unlocks a reused number only once, answering start as sent without paying or revealing the claim', async () => {
    const [a, b] = [await seedUser(), await seedUser()];
    await startPhoneUnlock(a, NUMBER, req());
    expect(await runNoCardUnlock('phone_verified', a, { phoneCode: '123456' })).toMatchObject({
      creditsGranted: PHONE_CREDITS,
    });
    const startedAt = Date.now();
    expect(await startPhoneUnlock(b, NUMBER, req('81.2.70.9'))).toEqual({ sent: true, sentTo: NUMBER });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(500);
    expect(sentCount()).toBe(1);
    vi.stubGlobal('fetch', (fetchMock = twilioFetch({ checkStatus: 404 })));
    expect(await runNoCardUnlock('phone_verified', b, { phoneCode: '123456' })).toMatchObject({
      creditsGranted: 0,
      refusal: 'phone_code_invalid',
    });
  });

  it('refuses the claim when two accounts race the same number through verify', async () => {
    const [a, b] = [await seedUser(), await seedUser()];
    await startPhoneUnlock(a, NUMBER, req());
    await startPhoneUnlock(b, NUMBER, req('81.2.70.9'));
    const results = await Promise.all([
      runNoCardUnlock('phone_verified', a, { phoneCode: '123456' }),
      runNoCardUnlock('phone_verified', b, { phoneCode: '123456' }),
    ]);
    expect(results.filter(r => r.creditsGranted > 0)).toHaveLength(1);
    expect(results.map(r => r.refusal).filter(Boolean)).toEqual(['phone_already_claimed']);
  });

  it('refuses verify with no code sent, and a wrong code without claiming the number', async () => {
    const id = await seedUser();
    expect(await runNoCardUnlock('phone_verified', id, { phoneCode: '123456' })).toMatchObject({
      refusal: 'phone_not_started',
    });
    vi.stubGlobal('fetch', (fetchMock = twilioFetch({ approved: false })));
    await startPhoneUnlock(id, NUMBER, req());
    expect(await runNoCardUnlock('phone_verified', id, { phoneCode: '000000' })).toMatchObject({
      creditsGranted: 0,
      refusal: 'phone_code_invalid',
    });
    expect(await PhoneUnlockClaim.countDocuments({})).toBe(0);
  });

  it('refuses a blocked range before any paid Twilio call', async () => {
    await AdminSettings.create({ settingName: 'noCardUnlockPhoneBlockedPrefixes', settingValue: '["+4477009"]' });
    const id = await seedUser();
    expect(await startPhoneUnlock(id, NUMBER, req())).toEqual({ sent: false, refusal: 'phone_blocked' });
    expect(twilioCalls()).toEqual([]);
  });

  it('refuses as disabled when the Twilio secrets are not configured', async () => {
    twilioConfig.TWILIO_ACCOUNT_SID = 'not-configured';
    const id = await seedUser();
    expect(await startPhoneUnlock(id, NUMBER, req())).toEqual({ sent: false, refusal: 'disabled' });
    expect(twilioCalls()).toEqual([]);
  });

  it('refuses a malformed number without touching the database or Twilio', async () => {
    expect(await startPhoneUnlock('u-none', '0770 090 0123', req())).toEqual({ sent: false, refusal: 'phone_invalid' });
    expect(twilioCalls()).toEqual([]);
  });

  it('does not spend the IP or network budget on a request the account cap refused', async () => {
    const id = await seedUser();
    const viaNetwork = (ip: string) => ({ headers: { 'x-real-ip': ip, 'cloudfront-viewer-asn': '64500' } });
    for (let i = 0; i < 3; i++) {
      await startPhoneUnlock(id, `+4477009003${i}0`, viaNetwork(`81.2.71.${i + 1}`));
    }
    const counters = () =>
      Cache.find({ key: { $in: ['phone-unlock:send:asn:64500', 'phone-unlock:send:ip:81.2.71.9'] } }, 'key result')
        .lean()
        .then(rows => Object.fromEntries(rows.map(row => [row.key, row.result])));
    const before = await counters();
    expect(before).toEqual({ 'phone-unlock:send:asn:64500': { count: 3 } });

    for (let i = 0; i < 5; i++) {
      expect(await startPhoneUnlock(id, '+447700900399', viaNetwork('81.2.71.9'))).toEqual({
        sent: false,
        refusal: 'phone_rate_limited',
      });
    }
    expect(await counters()).toEqual(before);
  });

  it('caps sends per account and per source IP', async () => {
    const id = await seedUser();
    for (let i = 0; i < 3; i++) {
      expect(await startPhoneUnlock(id, `+4477009001${i}0`, req(`81.2.69.${i + 10}`))).toEqual({
        sent: true,
        sentTo: expect.any(String),
      });
    }
    expect(await startPhoneUnlock(id, '+447700900199', req('81.2.69.99'))).toEqual({
      sent: false,
      refusal: 'phone_rate_limited',
    });

    const shared = req('81.2.69.50');
    for (let i = 0; i < 5; i++) {
      expect(await startPhoneUnlock(await seedUser(), `+4477009002${i}0`, shared)).toEqual({
        sent: true,
        sentTo: expect.any(String),
      });
    }
    expect(await startPhoneUnlock(await seedUser(), '+447700900299', shared)).toEqual({
      sent: false,
      refusal: 'phone_rate_limited',
    });
  });

  it('maps a Twilio max-send-attempts error to a rate-limit refusal', async () => {
    vi.stubGlobal('fetch', (fetchMock = twilioFetch({ sendStatus: 429, sendCode: 60203 })));
    const id = await seedUser();
    expect(await startPhoneUnlock(id, NUMBER, req())).toEqual({ sent: false, refusal: 'phone_rate_limited' });
    expect(await Cache.countDocuments({ key: `phone-unlock:pending:${id}` })).toBe(0);
  });

  it('treats a different spelling of a claimed number as the same number', async () => {
    const [a, b] = [await seedUser(), await seedUser()];
    await startPhoneUnlock(a, NUMBER, req());
    await runNoCardUnlock('phone_verified', a, { phoneCode: '123456' });

    vi.stubGlobal('fetch', (fetchMock = twilioFetch({ canonical: NUMBER })));
    expect(await startPhoneUnlock(b, '+4407700900123', req('81.2.70.9'))).toEqual({ sent: true, sentTo: NUMBER });
    expect(sentCount()).toBe(0);
    expect(await runNoCardUnlock('phone_verified', b, { phoneCode: '123456' })).toMatchObject({
      refusal: 'phone_already_claimed',
    });
  });

  it('sends to and binds the canonical number, so verify claims it', async () => {
    vi.stubGlobal('fetch', (fetchMock = twilioFetch({ canonical: NUMBER })));
    const id = await seedUser();
    expect(await startPhoneUnlock(id, '+4407700900123', req())).toEqual({ sent: true, sentTo: NUMBER });
    const send = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/Verifications'));
    expect(String((send?.[1] as RequestInit).body)).toContain(encodeURIComponent(NUMBER));
    await runNoCardUnlock('phone_verified', id, { phoneCode: '123456' });
    expect((await PhoneUnlockClaim.findOne({}).lean())?.phoneHash).toBe(hashPhone(NUMBER));
  });

  it('spends nothing on Twilio for a user who could not be granted', async () => {
    const id = await seedUser();
    await CreditTransaction.create({
      ownerId: id,
      ownerType: CreditHolderType.User,
      credits: PHONE_CREDITS,
      type: 'generic_add',
      reason: 'no_card_unlock:phone_verified',
      transactionId: noCardUnlockTransactionId('phone_verified', id),
    });
    expect(await startPhoneUnlock(id, NUMBER, req())).toEqual({ sent: false, refusal: 'already_granted' });
    expect(twilioCalls()).toEqual([]);
  });

  it('refuses verify on a cap filled after the send without spending the code check', async () => {
    const id = await seedUser();
    await startPhoneUnlock(id, NUMBER, req());
    await CreditTransaction.create({
      ownerId: id,
      ownerType: CreditHolderType.User,
      credits: 15,
      type: 'generic_add',
      reason: 'no_card_unlock:github_verified',
      transactionId: noCardUnlockTransactionId('github_verified', id),
    });
    expect(await runNoCardUnlock('phone_verified', id, { phoneCode: '123456' })).toMatchObject({
      refusal: 'cap_reached',
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/VerificationCheck'))).toBe(false);
  });

  it('caps sends per number country from the admin setting', async () => {
    await AdminSettings.create({ settingName: 'noCardUnlockPhoneCountryDailyCap', settingValue: 1 });
    expect(await startPhoneUnlock(await seedUser(), NUMBER, req('81.2.70.1'))).toEqual({
      sent: true,
      sentTo: expect.any(String),
    });
    expect(await startPhoneUnlock(await seedUser(), '+447700900124', req('81.2.70.2'))).toEqual({
      sent: false,
      refusal: 'phone_rate_limited',
    });
  });

  it('caps code checks per account', async () => {
    vi.stubGlobal('fetch', (fetchMock = twilioFetch({ approved: false })));
    const id = await seedUser();
    await startPhoneUnlock(id, NUMBER, req());
    for (let i = 0; i < 10; i++) {
      expect(await runNoCardUnlock('phone_verified', id, { phoneCode: '000000' })).toMatchObject({
        refusal: 'phone_code_invalid',
      });
    }
    expect(await runNoCardUnlock('phone_verified', id, { phoneCode: '000000' })).toMatchObject({
      refusal: 'phone_rate_limited',
    });
  });

  it('answers a wrong code, not a server error, once Twilio stops accepting checks', async () => {
    vi.stubGlobal('fetch', (fetchMock = twilioFetch({ checkStatus: 429, checkCode: 60202 })));
    const id = await seedUser();
    await startPhoneUnlock(id, NUMBER, req());
    expect(await runNoCardUnlock('phone_verified', id, { phoneCode: '123456' })).toMatchObject({
      creditsGranted: 0,
      refusal: 'phone_code_invalid',
    });
  });

  it('answers retryable, not a server error, when Twilio is down at verify, and keeps the number free', async () => {
    vi.stubGlobal('fetch', (fetchMock = twilioFetch({ checkStatus: 503 })));
    const id = await seedUser();
    await startPhoneUnlock(id, NUMBER, req());
    expect(await runNoCardUnlock('phone_verified', id, { phoneCode: '123456' })).toMatchObject({
      creditsGranted: 0,
      refusal: 'phone_unavailable',
    });
    expect(await PhoneUnlockClaim.countDocuments({ phoneHash: hashPhone(NUMBER) })).toBe(0);
  });

  it.each([
    ['a Twilio 5xx', () => new Response('{}', { status: 503 })],
    [
      'a request timeout',
      () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
    ],
  ])('maps %s on send to a retryable refusal', async (_label, failSend) => {
    const ok = twilioFetch();
    vi.stubGlobal(
      'fetch',
      (fetchMock = vi.fn(async (url: string) => (url.endsWith('/Verifications') ? failSend() : ok(url))))
    );
    expect(await startPhoneUnlock(await seedUser(), NUMBER, req())).toEqual({
      sent: false,
      refusal: 'phone_unavailable',
    });
  });

  it('maps a Fraud Guard block on send to a blocked refusal', async () => {
    vi.stubGlobal('fetch', (fetchMock = twilioFetch({ sendStatus: 403, sendCode: 60410 })));
    expect(await startPhoneUnlock(await seedUser(), NUMBER, req())).toEqual({ sent: false, refusal: 'phone_blocked' });
  });
});

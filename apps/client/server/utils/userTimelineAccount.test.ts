import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

const { findReview, disposableSources, authEventFind, loginAggregate } = vi.hoisted(() => ({
  findReview: vi.fn(),
  disposableSources: vi.fn(),
  authEventFind: vi.fn(),
  loginAggregate: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  AuthEventModel: { find: authEventFind },
  disposableDomainRepository: { disposableSources },
  ImageModerationIncident: {},
  PaymentAttemptModel: {},
  signupProtectionRepository: { findReview },
  UserAuthAuditLogModel: { aggregate: loginAggregate },
}));

import { emailDomainOf, fetchSignupEntries, isInWindow, loadSignInNetworks } from './userTimelineAccount';

const USER_ID = '6700000000000000000000aa';
const createdAt = new Date('2026-11-01T10:00:00Z');

beforeEach(() => {
  findReview.mockReset().mockResolvedValue(null);
  disposableSources.mockReset().mockResolvedValue([]);
});

describe('emailDomainOf', () => {
  it('lowercases the part after the last @', () => {
    expect(emailDomainOf('a@b@Example.COM')).toBe('example.com');
    expect(emailDomainOf('no-at-sign')).toBeUndefined();
    expect(emailDomainOf(undefined)).toBeUndefined();
  });
});

describe('isInWindow', () => {
  const at = new Date('2026-11-01T10:00:00Z');
  it('honours the range and is strictly older than the cursor', () => {
    expect(isInWindow(at, 'b', { range: { from: new Date('2026-11-02') } })).toBe(false);
    expect(isInWindow(at, 'b', { range: {}, cursor: { occurredAt: at, id: 'c' } })).toBe(true);
    expect(isInWindow(at, 'b', { range: {}, cursor: { occurredAt: at, id: 'b' } })).toBe(false);
  });
});

describe('fetchSignupEntries', () => {
  it('builds the signup row with network detail and the risk flags', async () => {
    disposableSources.mockResolvedValue(['list']);
    findReview.mockResolvedValue({ status: 'held_pending_review' });

    const { entries } = await fetchSignupEntries(
      USER_ID,
      {
        createdAt,
        currentCredits: 0,
        email: 'someone@mailer.test',
        signupMeta: { ip: '203.0.113.9', country: 'NL', asn: 64500, asnOrg: 'Hosting', isDatacenter: true },
        signupGrantHeldReason: 'risk_review',
      },
      { range: {} }
    );

    expect(entries).toEqual([
      expect.objectContaining({
        type: 'signup',
        id: USER_ID,
        at: createdAt,
        detail: '203.0.113.9 \u00b7 NL \u00b7 AS64500 Hosting \u00b7 @mailer.test',
        flags: ['Disposable domain', 'Domain held', 'Datacenter IP', 'Signup credits held: risk review'],
        alert: true,
      }),
    ]);
  });

  it('does not alert on a datacenter IP alone', async () => {
    const { entries } = await fetchSignupEntries(
      USER_ID,
      { createdAt, currentCredits: 0, email: 'a@b.test', signupMeta: { isDatacenter: true } },
      { range: {} }
    );
    expect(entries[0]).toMatchObject({ flags: ['Datacenter IP'], alert: undefined });
  });

  it('is absent outside the window', async () => {
    const { entries } = await fetchSignupEntries(
      USER_ID,
      { createdAt, currentCredits: 0 },
      { range: { to: new Date('2026-10-01') } }
    );
    expect(entries).toEqual([]);
    expect(findReview).not.toHaveBeenCalled();
  });
});

describe('loadSignInNetworks', () => {
  const chain = (rows: unknown[]) => {
    const query = {
      select: () => query,
      sort: () => query,
      limit: () => query,
      maxTimeMS: () => query,
      lean: () => Promise.resolve(rows),
    };
    return query;
  };

  it('flags the first login from an IP or country that the signup did not use', async () => {
    const first = new Types.ObjectId();
    const second = new Types.ObjectId();
    const third = new Types.ObjectId();
    const t1 = new Date('2026-11-01T11:00:00Z');
    const t2 = new Date('2026-11-02T11:00:00Z');
    const t3 = new Date('2026-11-03T11:00:00Z');
    loginAggregate.mockReturnValue({
      option: () =>
        Promise.resolve([
          { _id: '198.51.100.1', first: t1 },
          { _id: '198.51.100.2', first: t2 },
        ]),
    });
    authEventFind.mockReturnValue(
      chain([
        { ip: '198.51.100.1', country: 'NL', createdAt: t1 },
        { ip: '198.51.100.2', country: 'BR', createdAt: t2 },
        { ip: '198.51.100.1', country: 'NL', createdAt: t3 },
      ])
    );

    const networks = await loadSignInNetworks(
      USER_ID,
      [
        { _id: first, event: 'login_success', actorIp: '198.51.100.1', createdAt: t1 },
        { _id: second, event: 'login_success', actorIp: '198.51.100.2', createdAt: t2 },
        { _id: third, event: 'login_success', actorIp: '198.51.100.1', createdAt: t3 },
      ],
      { ip: '198.51.100.1', country: 'NL' }
    );

    expect(networks.get(first.toHexString())).toEqual({ country: 'NL', newIp: false, newCountry: false });
    expect(networks.get(second.toHexString())).toEqual({ country: 'BR', newIp: true, newCountry: true });
    expect(networks.get(third.toHexString())).toEqual({ country: 'NL', newIp: false, newCountry: false });
  });
});

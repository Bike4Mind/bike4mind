import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { pseudonymiseEvidence } from './pseudonymiseEvidence';

const SALT = 'test-salt-for-evidence';

const USER_ID = new Types.ObjectId();
const ORG_ID = '65a1b2c3d4e5f60718293a4b';
const EMAIL = 'Jane.Doe@example.com';
const IPV4 = '203.0.113.42';
const IPV6 = '2001:db8::8a2e:370:7334';
const FINGERPRINT = 'fp_9f8e7d6c5b4a';
const DEVICE_UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

const fixture = () => ({
  user: {
    _id: USER_ID,
    email: EMAIL,
    organizationId: ORG_ID,
    signupIp: IPV4,
    createdAt: new Date('2026-01-02T03:04:05Z'),
    isAdmin: false,
    credits: 12,
  },
  detection: {
    kind: 'velocity',
    fingerprint: FINGERPRINT,
    deviceId: DEVICE_UUID,
    notes: `Login from ${IPV6} at 07:17:31 by ${EMAIL.toLowerCase()} (user ${USER_ID.toHexString()})`,
    relatedIps: [IPV4, '198.51.100.7'],
    events: [{ ipAddress: IPV4, at: '2026-01-02' }, { ipAddress: IPV6 }],
  },
  render: () => 'dropped',
  missing: undefined,
});

const leaks = (json: string) =>
  [
    EMAIL,
    EMAIL.toLowerCase(),
    IPV4,
    '198.51.100.7',
    IPV6,
    FINGERPRINT,
    DEVICE_UUID,
    ORG_ID,
    USER_ID.toHexString(),
  ].filter(value => json.includes(value));

describe('pseudonymiseEvidence', () => {
  it('removes every email, IP, ObjectId, uuid and fingerprint from a realistic payload', () => {
    const out = pseudonymiseEvidence(fixture(), SALT) as Record<string, Record<string, unknown>>;
    expect(leaks(JSON.stringify(out))).toEqual([]);
    expect(out.user.isAdmin).toBe(false);
    expect(out.user.credits).toBe(12);
    expect(out.user.createdAt).toBe('2026-01-02T03:04:05.000Z');
    expect(out.detection.kind).toBe('velocity');
    expect(out.detection.notes).toContain('07:17:31');
    expect(out).not.toHaveProperty('render');
    expect(out).not.toHaveProperty('missing');
  });

  it('gives one entity the same token wherever it appears, including inside free text', () => {
    const out = pseudonymiseEvidence(fixture(), SALT) as {
      user: { email: string; _id: string; signupIp: string };
      detection: { notes: string; relatedIps: string[]; events: Array<{ ipAddress: string }> };
    };
    expect(out.user.email).toMatch(/^p_[0-9a-f]{12}$/);
    expect(out.detection.notes).toContain(out.user.email);
    expect(out.detection.notes).toContain(out.user._id);
    expect(out.detection.relatedIps[0]).toBe(out.user.signupIp);
    expect(out.detection.events[0].ipAddress).toBe(out.user.signupIp);
    expect(out.detection.relatedIps[1]).not.toBe(out.user.signupIp);
  });

  it('is stable across calls and changes with the salt', () => {
    expect(pseudonymiseEvidence(fixture(), SALT)).toEqual(pseudonymiseEvidence(fixture(), SALT));
    expect(pseudonymiseEvidence({ email: EMAIL }, SALT)).not.toEqual(pseudonymiseEvidence({ email: EMAIL }, 'other'));
  });

  it.each([
    ['empty', ''],
    ['placeholder', 'not-configured'],
  ])('fails closed to fixed redaction with a %s salt', (_label, salt) => {
    const out = pseudonymiseEvidence(fixture(), salt) as {
      user: Record<string, unknown>;
      detection: Record<string, unknown>;
    };
    expect(leaks(JSON.stringify(out))).toEqual([]);
    expect(JSON.stringify(out)).not.toMatch(/p_[0-9a-f]{12}/);
    expect(out.user.email).toBe('[redacted-email]');
    expect(out.user.signupIp).toBe('[redacted-ip]');
    expect(out.user._id).toBe('[redacted-id]');
    expect(out.detection.notes).toContain('[redacted-ip]');
    expect(out.detection.notes).toContain('[redacted-email]');
  });

  it('walks nested arrays and caps depth', () => {
    const out = pseudonymiseEvidence({ a: [[{ contact: `mail ${EMAIL}` }]] }, SALT) as { a: [[{ contact: string }]] };
    expect(out.a[0][0].contact).toMatch(/^mail p_[0-9a-f]{12}$/);

    let deep: Record<string, unknown> = { leaf: EMAIL };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    expect(leaks(JSON.stringify(pseudonymiseEvidence(deep, SALT)))).toEqual([]);
  });

  it('does not treat words that merely end in "ip" as IP keys', () => {
    const out = pseudonymiseEvidence({ ownership: 'org', membership: 'paid' }, SALT);
    expect(out).toEqual({ ownership: 'org', membership: 'paid' });
  });

  it('passes non-object input through, scrubbing a bare string', () => {
    expect(pseudonymiseEvidence(42, SALT)).toBe(42);
    expect(pseudonymiseEvidence(null, SALT)).toBeNull();
    expect(pseudonymiseEvidence(true, SALT)).toBe(true);
    expect(pseudonymiseEvidence(`from ${IPV4}`, SALT)).toMatch(/^from p_[0-9a-f]{12}$/);
    expect(pseudonymiseEvidence(() => 1, SALT)).toBeNull();
  });

  it('scrubs identifiers used as object keys', () => {
    const json = JSON.stringify(
      pseudonymiseEvidence({ bySender: { [EMAIL]: 3 }, bySource: { [IPV4]: 2, [IPV6]: 1 } }, SALT)
    );
    expect(leaks(json)).toEqual([]);
    expect(json).toContain(':3');
  });

  it('keeps colliding keys apart when they redact to the same marker', () => {
    const out = pseudonymiseEvidence({ 'a@example.com': 1, 'b@example.com': 2 }, '');
    expect(out).toEqual({ '[redacted-email]': 1, '[redacted-email]#2': 2 });
  });

  it('skips a suffix a raw key already holds and stays linear across many colliding keys', () => {
    expect(pseudonymiseEvidence({ 'a@example.com': 1, '[redacted-email]#2': 'x', 'b@example.com': 2 }, '')).toEqual({
      '[redacted-email]': 1,
      '[redacted-email]#2': 'x',
      '[redacted-email]#3': 2,
    });

    const many = Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`u${i}@example.com`, i]));
    const started = performance.now();
    const out = pseudonymiseEvidence(many, '') as Record<string, number>;
    // Probing from #2 per key took ~15s at 8k keys; linear is well under a second at 20k.
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(Object.keys(out)).toHaveLength(20_000);
    expect(out['[redacted-email]#20000']).toBe(19_999);
  });

  it('tokenises names, usernames and phone numbers', () => {
    const user = { name: 'Jane Doe', username: 'jdoe', displayName: 'JD', phone: '+15555550100', fileName: 'a.csv' };
    const out = pseudonymiseEvidence(user, SALT) as Record<string, string>;
    for (const key of ['name', 'username', 'displayName', 'phone']) expect(out[key]).toMatch(/^p_[0-9a-f]{12}$/);
    expect(out.fileName).toBe('a.csv');
    expect(pseudonymiseEvidence({ phone: '+15555550100' }, '')).toEqual({ phone: '[redacted-phone]' });
  });

  it.each([
    ['trailing colon', 'conn from 2001:db8::1: reset'],
    ['trailing period', 'last seen at 2001:db8::1.'],
    ['word prefix', 'from:2001:db8::1 ok'],
    ['hex word prefix', 'cafe:2001:db8::1'],
  ])('scrubs an IPv6 address with a %s', (_label, text) => {
    const out = pseudonymiseEvidence(text, SALT) as string;
    expect(out).not.toContain('2001:db8');
    expect(out).toMatch(/p_[0-9a-f]{12}/);
  });

  it('does not reuse the analytics pseudonym for an id', async () => {
    const { pseudonymize } = await import('@bike4mind/server-utils/analytics/pseudonymize');
    const out = pseudonymiseEvidence({ userId: ORG_ID }, SALT) as { userId: string };
    expect(out.userId).not.toBe(`p_${pseudonymize(ORG_ID, SALT).slice(0, 12)}`);
  });
});

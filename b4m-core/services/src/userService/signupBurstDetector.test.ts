import { describe, expect, it } from 'vitest';
import type { SignupObservation } from '@bike4mind/common';
import { detectSignupBurst, signupDomain } from './signupBurstDetector';

const now = new Date('2026-01-01T12:00:00Z');
const since = new Date('2026-01-01T06:00:00Z');
const domain = 'example.net';
const options = { domain, threshold: 5, since };
const emails = [
  'alice28aa82@fj.example.net',
  'raina28acf6@7y.example.net',
  'merlin28af6a@c5.example.net',
  'aubrey28b850@np.example.net',
  'jane28c685@ax.example.net',
];
const observations = (addresses: string[]): SignupObservation[] =>
  addresses.map((email, index) => ({
    userId: `user-${index}`,
    email,
    domain: signupDomain(email) ?? '',
    verifiedAt: new Date(now.getTime() + index),
  }));

describe('signup burst detector', () => {
  it('collapses short subdomains and private suffixes correctly', () => {
    expect(signupDomain('x@fj.example.co.uk')).toBe('example.co.uk');
    expect(signupDomain('x@a.github.io')).toBe('a.github.io');
    expect(signupDomain('invalid')).toBeNull();
  });
  it('detects generated increasing suffixes across random subdomains', () => {
    expect(detectSignupBurst(observations(emails), options)).toMatchObject({ suspicious: true, signupCount: 5 });
  });
  it('still detects the counter cohort when unrelated numeric addresses interrupt it', () => {
    const mixed = [...emails.slice(0, 4), 'employee2025@example.net', emails[4]];
    expect(detectSignupBurst(observations(mixed), options).suspicious).toBe(true);
  });
  it('detects a shared generated prefix even without random subdomains', () => {
    const addresses = [9, 6, 4, 2, 1].map(value => `alice28aa0${value}@example.net`);
    expect(detectSignupBurst(observations(addresses), options).suspicious).toBe(true);
  });
  it('leaves an ID-style cohort alone even when it contains a short increasing run', () => {
    const ids = ['2041', '1187', '3302', '2290', '4415', '3876', '1550', '5123', '4790', '6034', '2755', '7012'];
    const names = ['ab', 'cd', 'ef', 'gh', 'ij', 'kl', 'mn', 'op', 'qr', 'st', 'uv', 'wx'];
    const addresses = ids.map((id, index) => `${names[index]}${id}@example.net`);
    expect(detectSignupBurst(observations(addresses), options).suspicious).toBe(false);
  });
  it('leaves five normal company employees alone', () => {
    const addresses = ['alice', 'bob', 'carol', 'dave', 'eve'].map(name => `${name}@example.net`);
    expect(detectSignupBurst(observations(addresses), options).suspicious).toBe(false);
  });
  it('does not use volume or rotating subdomains alone as a verdict', () => {
    expect(
      detectSignupBurst(observations(emails.map(email => email.replace(/28[a-f0-9]+/, ''))), options).suspicious
    ).toBe(false);
  });
  it('ignores old signups, duplicate users, other domains, and a below-threshold burst', () => {
    const cohort = observations(emails);
    expect(detectSignupBurst(cohort.slice(0, 4), options).suspicious).toBe(false);
    expect(detectSignupBurst([...cohort.slice(0, 4), cohort[0]], options).signupCount).toBe(4);
    cohort[0].verifiedAt = new Date('2025-12-31');
    expect(detectSignupBurst(cohort, options).suspicious).toBe(false);
    cohort[0] = { ...cohort[1], userId: 'outsider', domain: 'example.org' };
    expect(detectSignupBurst(cohort, options).suspicious).toBe(false);
  });
});

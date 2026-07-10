import { describe, it, expect, afterEach } from 'vitest';
import { inferOrganizationFromEmail, isPersonalEmail } from '../organizationUtils';

// Deterministic config injected via options so these tests don't depend on env.
const opts = {
  internalStaffDomains: ['bike4mind.com', 'milliononmars.com'],
  internalOrgDisplayNames: { 'milliononmars.com': 'Million on Mars' },
};

describe('inferOrganizationFromEmail', () => {
  it('returns "Unknown" for missing or malformed email', () => {
    expect(inferOrganizationFromEmail(undefined, opts)).toBe('Unknown');
    expect(inferOrganizationFromEmail('', opts)).toBe('Unknown');
    expect(inferOrganizationFromEmail('noatsign', opts)).toBe('Unknown');
  });

  it('resolves an internal domain to its curated display name (no hardcoded literal)', () => {
    expect(inferOrganizationFromEmail('alice@milliononmars.com', opts)).toBe('Million on Mars');
  });

  it('is case-insensitive on the domain', () => {
    expect(inferOrganizationFromEmail('Alice@MILLIONONMARS.com', opts)).toBe('Million on Mars');
  });

  it('falls back to the title-cased domain for an internal domain with no curated label', () => {
    // bike4mind.com is internal but not in the display-name map -> title-cased label.
    expect(inferOrganizationFromEmail('dev@bike4mind.com', opts)).toBe('Bike4mind');
  });

  it('returns "Personal" for personal email providers', () => {
    expect(inferOrganizationFromEmail('someone@gmail.com', opts)).toBe('Personal');
    expect(isPersonalEmail('someone@gmail.com')).toBe(true);
  });

  it('title-cases an external company domain', () => {
    expect(inferOrganizationFromEmail('bob@acme.com', opts)).toBe('Acme');
    expect(inferOrganizationFromEmail('bob@acme.co.uk', opts)).toBe('Acme');
  });

  it('does NOT treat a substring match as internal (exact domain only)', () => {
    // "notmilliononmars.com" is not in the internal list -> title-cased, not "Million on Mars".
    expect(inferOrganizationFromEmail('eve@notmilliononmars.com', opts)).toBe('Notmilliononmars');
  });

  it('with no internal domains configured, no email is treated as internal', () => {
    expect(
      inferOrganizationFromEmail('alice@milliononmars.com', {
        internalStaffDomains: [],
        internalOrgDisplayNames: {},
      })
    ).toBe('Milliononmars');
  });

  describe('env defaults (no options passed)', () => {
    const prevDomains = process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS;
    const prevLabels = process.env.NEXT_PUBLIC_INTERNAL_ORG_DISPLAY_NAMES;
    afterEach(() => {
      process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS = prevDomains;
      process.env.NEXT_PUBLIC_INTERNAL_ORG_DISPLAY_NAMES = prevLabels;
    });

    it('resolves internal staff + curated label from env when options are omitted', () => {
      process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS = 'bike4mind.com,milliononmars.com';
      process.env.NEXT_PUBLIC_INTERNAL_ORG_DISPLAY_NAMES = 'milliononmars.com:Million on Mars';
      expect(inferOrganizationFromEmail('alice@milliononmars.com')).toBe('Million on Mars');
    });

    it('title-cases (no brand fallback) when env is unset', () => {
      delete process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS;
      delete process.env.NEXT_PUBLIC_INTERNAL_ORG_DISPLAY_NAMES;
      expect(inferOrganizationFromEmail('alice@milliononmars.com')).toBe('Milliononmars');
    });
  });
});

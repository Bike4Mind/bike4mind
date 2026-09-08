import { describe, it, expect } from 'vitest';

import { readEgressHosts, isExactlyOldDefault } from './20260814000000_pr-report-webhook-settings';

/**
 * The migration only re-points an allowlist that holds EXACTLY the old Slack-API default,
 * so a customized list is never clobbered. These pin that guard and the object/JSON-string
 * shape handling, without a database.
 */

describe('readEgressHosts', () => {
  it('reads hosts from an object value', () => {
    expect(readEgressHosts({ hosts: ['slack.com', 'www.slack.com'] })).toEqual(['slack.com', 'www.slack.com']);
  });

  it('reads hosts from a JSON string value', () => {
    expect(readEgressHosts('{"hosts":["hooks.slack.com"]}')).toEqual(['hooks.slack.com']);
  });

  it('drops non-string entries rather than trusting them', () => {
    expect(readEgressHosts({ hosts: ['slack.com', 42, null] })).toEqual(['slack.com']);
  });

  it('returns null for a non-hosts shape or unparseable string', () => {
    expect(readEgressHosts({ nope: true })).toBeNull();
    expect(readEgressHosts('not json')).toBeNull();
    expect(readEgressHosts(undefined)).toBeNull();
  });
});

describe('isExactlyOldDefault', () => {
  it('matches the old default regardless of order or case', () => {
    expect(isExactlyOldDefault(['slack.com', 'www.slack.com'])).toBe(true);
    expect(isExactlyOldDefault(['www.slack.com', 'SLACK.COM'])).toBe(true);
  });

  it('does not match a customized or already-migrated list', () => {
    expect(isExactlyOldDefault(['hooks.slack.com'])).toBe(false); // already migrated
    expect(isExactlyOldDefault(['slack.com', 'www.slack.com', 'proxy.internal'])).toBe(false); // extra host
    expect(isExactlyOldDefault(['slack.com'])).toBe(false); // subset
    expect(isExactlyOldDefault([])).toBe(false);
  });
});

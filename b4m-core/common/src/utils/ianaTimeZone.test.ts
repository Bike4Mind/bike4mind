import { describe, expect, it } from 'vitest';
import { isValidIanaTimeZone } from './ianaTimeZone';

describe('isValidIanaTimeZone', () => {
  it.each(['America/New_York', 'Asia/Kathmandu', 'Pacific/Kiritimati', 'UTC', 'Etc/GMT+5'])('accepts %s', tz => {
    expect(isValidIanaTimeZone(tz)).toBe(true);
  });

  it.each(['', 'Mars/Base', 'America/Nowhere', '+05:30', '-0800', 'not a zone'])('rejects %j', tz => {
    expect(isValidIanaTimeZone(tz)).toBe(false);
  });
});

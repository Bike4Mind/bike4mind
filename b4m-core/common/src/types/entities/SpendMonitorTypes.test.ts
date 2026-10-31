import { describe, it, expect } from 'vitest';
import { floorToBucket, spendAlertOpenKey } from './SpendMonitorTypes';

describe('floorToBucket', () => {
  it('floors a mid-bucket timestamp to the 5-minute boundary', () => {
    expect(floorToBucket(new Date('2026-10-30T10:07:59.999Z')).toISOString()).toBe('2026-10-30T10:05:00.000Z');
  });

  it('maps an exact boundary to itself', () => {
    expect(floorToBucket(new Date('2026-10-30T10:05:00.000Z')).toISOString()).toBe('2026-10-30T10:05:00.000Z');
  });
});

describe('spendAlertOpenKey', () => {
  it('joins rule, scope type and scope id with colons', () => {
    expect(spendAlertOpenKey('account_spike', 'User', 'u1')).toBe('account_spike:User:u1');
  });
});

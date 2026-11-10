import { describe, expect, it } from 'vitest';
import { redactIpAddresses } from './redactIpAddresses';

describe('redactIpAddresses', () => {
  it.each([
    ['Auto-block of IP 203.0.113.7 not committed', 'Auto-block of IP [IP] not committed'],
    ['from 203.0.113.7.', 'from [IP].'],
    ['"clientIp":"136.49.141.53"', '"clientIp":"[IP]"'],
    ['ip=10.0.0.1, next', 'ip=[IP], next'],
    ['peer 2001:db8::1 reset', 'peer [IP] reset'],
    ['peer 2001:0db8:0000:0000:0000:ff00:0042:8329 reset', 'peer [IP] reset'],
    ['loopback ::1 only', 'loopback [IP] only'],
    ['mapped ::ffff:192.0.2.1', 'mapped [IP]'],
    ['FE80::ABCD (upper case)', '[IP] (upper case)'],
  ])('redacts %j', (input, expected) => {
    expect(redactIpAddresses(input)).toBe(expected);
  });

  it.each([
    '2024-11-25T00:53:48.462Z',
    'took 10:00:00 to finish',
    'openid-client@6.8.8/build',
    'chain 1.2.3.4.5 is not an address',
    'v1.2.3.4',
    'mac aa:bb:cc:dd:ee:ff',
    'Module::new and std::fs',
    'octet out of range 256.1.1.1',
    'Root=1-6743ca93-7e4c11143e5cf9251819409d',
  ])('leaves %j alone', input => {
    expect(redactIpAddresses(input)).toBe(input);
  });
});

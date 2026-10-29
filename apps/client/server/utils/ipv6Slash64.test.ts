import { describe, expect, it } from 'vitest';
import { ipv6Slash64 } from './ipv6Slash64';

describe('ipv6Slash64', () => {
  it('prints the /64 canonically however the address is written', () => {
    expect(ipv6Slash64('2001:0DB8:00aa:0001:ffff:0:0:1')).toBe('2001:db8:aa:1::/64');
    expect(ipv6Slash64('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipv6Slash64('::1')).toBe('0:0:0:0::/64');
    expect(ipv6Slash64('::')).toBe('0:0:0:0::/64');
  });

  it('rejects malformed addresses', () => {
    for (const bad of ['1::2::3', '1:2:3', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7:8::', '12345::1', 'g::1', '']) {
      expect(ipv6Slash64(bad)).toBeNull();
    }
  });
});

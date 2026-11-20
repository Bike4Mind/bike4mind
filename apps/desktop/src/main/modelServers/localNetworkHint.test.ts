import { describe, expect, it } from 'vitest';
import { LOCAL_NETWORK_HINT, localNetworkHint, withLocalNetworkHint } from './localNetworkHint';

describe('localNetworkHint', () => {
  it('applies to an unreachable private address on macOS', () => {
    expect(localNetworkHint('EHOSTUNREACH', 'private', 'darwin')).toBe(LOCAL_NETWORK_HINT);
    expect(localNetworkHint('ENETUNREACH', 'private', 'darwin')).toBe(LOCAL_NETWORK_HINT);
  });

  it('does not apply on other platforms, to other scopes or to other failures', () => {
    expect(localNetworkHint('EHOSTUNREACH', 'private', 'linux')).toBeNull();
    expect(localNetworkHint('EHOSTUNREACH', 'private', 'win32')).toBeNull();
    expect(localNetworkHint('EHOSTUNREACH', 'public', 'darwin')).toBeNull();
    expect(localNetworkHint('EHOSTUNREACH', 'loopback', 'darwin')).toBeNull();
    expect(localNetworkHint('EHOSTUNREACH', null, 'darwin')).toBeNull();
    expect(localNetworkHint('ECONNREFUSED', 'private', 'darwin')).toBeNull();
    expect(localNetworkHint(null, 'private', 'darwin')).toBeNull();
  });

  it('appends the hint to a message only when it applies', () => {
    expect(withLocalNetworkHint('Could not reach gpu box.', 'EHOSTUNREACH', 'private', 'darwin')).toBe(
      `Could not reach gpu box. ${LOCAL_NETWORK_HINT}`
    );
    expect(
      withLocalNetworkHint('Could not reach gpu box: no route to the host', 'EHOSTUNREACH', 'private', 'darwin')
    ).toBe(`Could not reach gpu box: no route to the host. ${LOCAL_NETWORK_HINT}`);
    expect(withLocalNetworkHint('Could not reach gpu box.', 'EHOSTUNREACH', 'private', 'linux')).toBe(
      'Could not reach gpu box.'
    );
  });
});

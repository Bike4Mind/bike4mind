import { describe, it, expect } from 'vitest';
import { parseProcNetForUid, parseLsofForUid } from './peerOwner.js';

// 0xBE5C === 48732 (the default bridge port); 0A === TCP_LISTEN.
const PROC_NET_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:BE5C 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 54321 1 0000000000000000 100 0 0 10 0
   1: 0100007F:0016 0100007F:C3A2 01 00000000:00000000 00:00000000 00000000     0        0 11111 1 0000000000000000 20 4 30 10 -1
`;

const PROC_NET_TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:BE5C 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 65432 1 0000000000000000 100 0 0 10 0
`;

// Same LISTEN port on a real interface (0501A8C0 == 192.168.1.5), a different
// UID. A port-only match would mis-attribute this to the loopback peer.
const PROC_NET_TCP_NONLOOPBACK = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0501A8C0:BE5C 00000000:0000 0A 00000000:00000000 00:00000000 00000000  2000        0 54321 1 0000000000000000 100 0 0 10 0
`;

describe('parseProcNetForUid', () => {
  it('returns the uid of a LISTEN socket matching the port', () => {
    expect(parseProcNetForUid(PROC_NET_TCP, 48732)).toBe(1000);
  });

  it('parses the tcp6 hex layout', () => {
    expect(parseProcNetForUid(PROC_NET_TCP6, 48732)).toBe(1000);
  });

  it('accepts a wildcard (0.0.0.0) bind on the port', () => {
    const wildcard = PROC_NET_TCP.replace('0100007F:BE5C', '00000000:BE5C');
    expect(parseProcNetForUid(wildcard, 48732)).toBe(1000);
  });

  it('ignores a same-port LISTEN socket on a non-loopback interface', () => {
    expect(parseProcNetForUid(PROC_NET_TCP_NONLOOPBACK, 48732)).toBeNull();
  });

  it('ignores non-LISTEN rows on the same port', () => {
    const established = PROC_NET_TCP.replace('BE5C 00000000:0000 0A', 'BE5C 00000000:0000 01');
    expect(parseProcNetForUid(established, 48732)).toBeNull();
  });

  it('returns null when no row matches the port', () => {
    expect(parseProcNetForUid(PROC_NET_TCP, 12345)).toBeNull();
  });

  it('returns null on an empty dump', () => {
    expect(parseProcNetForUid('', 48732)).toBeNull();
  });
});

describe('parseLsofForUid', () => {
  it('extracts the uid of a loopback listener from lsof -Fpun output', () => {
    expect(parseLsofForUid('p1234\nu501\nf3\nn127.0.0.1:48732\n')).toBe(501);
  });

  it('accepts a wildcard listener name', () => {
    expect(parseLsofForUid('p1234\nu501\nf3\nn*:48732\n')).toBe(501);
  });

  it('ignores a same-port listener on a non-loopback interface', () => {
    expect(parseLsofForUid('p1234\nu2000\nf3\nn192.168.1.5:48732\n')).toBeNull();
  });

  it('returns null when no uid field is present', () => {
    expect(parseLsofForUid('f3\nn127.0.0.1:48732\n')).toBeNull();
  });

  it('returns null on empty output', () => {
    expect(parseLsofForUid('')).toBeNull();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Seams for the resolver's platform dispatch. The pure parsers are tested
// directly below; these mocks let us exercise resolveLoopbackListenerOwner's
// linux (/proc), darwin (lsof), and unsupported-platform branches - the code
// that actually produces the trust signal - without a live socket.
const { readFileMock, accessMock, execFileMock } = vi.hoisted(() => ({
  readFileMock: vi.fn<(file: string) => Promise<string>>(),
  accessMock: vi.fn<(path: string) => Promise<void>>(),
  execFileMock: vi.fn(),
}));

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    constants: actual.constants,
    promises: {
      ...actual.promises,
      readFile: (file: string) => readFileMock(file),
      access: (path: string) => accessMock(path),
    },
  };
});

vi.mock('child_process', () => ({
  // promisify() wraps this; forwarding to the mock keeps the (file, args, opts,
  // cb) callback shape promisify expects.
  execFile: (...args: unknown[]) => (execFileMock as (...a: unknown[]) => unknown)(...args),
}));

const { parseProcNetForUid, parseLsofForUid, resolveLoopbackListenerOwner } = await import('./peerOwner.js');

// 0xBE5C === 48732 (the default bridge port); 0A === TCP_LISTEN.
const PROC_NET_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:BE5C 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 54321 1 0000000000000000 100 0 0 10 0
   1: 0100007F:0016 0100007F:C3A2 01 00000000:00000000 00:00000000 00000000     0        0 11111 1 0000000000000000 20 4 30 10 -1
`;

const PROC_NET_TCP6_LOOPBACK = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:BE5C 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 65432 1 0000000000000000 100 0 0 10 0
`;

// v4-mapped-in-v6 loopback (::ffff:127.0.0.1). /proc/net/tcp6 prints each word
// little-endian, so the mapped third word 00 00 ff ff reads FFFF0000.
const PROC_NET_TCP6_MAPPED = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0000000000000000FFFF00000100007F:BE5C 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 65432 1 0000000000000000 100 0 0 10 0
`;

const PROC_NET_TCP6_EMPTY = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
`;

// Same LISTEN port on a real interface (0501A8C0 == 192.168.1.5), a different
// UID. A port-only match would mis-attribute this to the loopback peer.
const PROC_NET_TCP_NONLOOPBACK = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0501A8C0:BE5C 00000000:0000 0A 00000000:00000000 00:00000000 00000000  2000        0 54321 1 0000000000000000 100 0 0 10 0
`;

describe('parseProcNetForUid', () => {
  it('returns the uid of a LISTEN socket matching the port', () => {
    expect(parseProcNetForUid(PROC_NET_TCP, 48732)).toEqual([1000]);
  });

  it('parses the tcp6 hex layout', () => {
    expect(parseProcNetForUid(PROC_NET_TCP6_LOOPBACK, 48732)).toEqual([1000]);
  });

  it('accepts a v4-mapped-in-v6 loopback bind (::ffff:127.0.0.1)', () => {
    expect(parseProcNetForUid(PROC_NET_TCP6_MAPPED, 48732)).toEqual([1000]);
  });

  it('accepts a wildcard (0.0.0.0) bind on the port', () => {
    const wildcard = PROC_NET_TCP.replace('0100007F:BE5C', '00000000:BE5C');
    expect(parseProcNetForUid(wildcard, 48732)).toEqual([1000]);
  });

  it('ignores a same-port LISTEN socket on a non-loopback interface', () => {
    expect(parseProcNetForUid(PROC_NET_TCP_NONLOOPBACK, 48732)).toEqual([]);
  });

  it('ignores non-LISTEN rows on the same port', () => {
    const established = PROC_NET_TCP.replace('BE5C 00000000:0000 0A', 'BE5C 00000000:0000 01');
    expect(parseProcNetForUid(established, 48732)).toEqual([]);
  });

  it('surfaces every matching owner so an ambiguous set can be rejected', () => {
    const two = `${PROC_NET_TCP}   2: 00000000:BE5C 00000000:0000 0A 00000000:00000000 00:00000000 00000000  2000        0 99999 1 0000000000000000 100 0 0 10 0\n`;
    expect(parseProcNetForUid(two, 48732).sort()).toEqual([1000, 2000]);
  });

  it('returns [] when no row matches the port', () => {
    expect(parseProcNetForUid(PROC_NET_TCP, 12345)).toEqual([]);
  });

  it('returns [] on an empty dump', () => {
    expect(parseProcNetForUid('', 48732)).toEqual([]);
  });
});

describe('parseLsofForUid', () => {
  it('extracts the uid of a loopback listener from lsof -Fpun output', () => {
    expect(parseLsofForUid('p1234\nu501\nf3\nn127.0.0.1:48732\n')).toEqual([501]);
  });

  it('accepts a wildcard listener name', () => {
    expect(parseLsofForUid('p1234\nu501\nf3\nn*:48732\n')).toEqual([501]);
  });

  it('accepts a mapped-loopback listener name', () => {
    expect(parseLsofForUid('p1234\nu501\nf3\nn[::ffff:127.0.0.1]:48732\n')).toEqual([501]);
  });

  it('ignores a same-port listener on a non-loopback interface', () => {
    expect(parseLsofForUid('p1234\nu2000\nf3\nn192.168.1.5:48732\n')).toEqual([]);
  });

  it('does not accept a non-exact 127.x name', () => {
    expect(parseLsofForUid('p1234\nu501\nf3\nn127.1.2.3:48732\n')).toEqual([]);
  });

  it('resets the uid on a new process block (no u => no inherited owner)', () => {
    expect(parseLsofForUid('p1\nu501\nf3\nn10.0.0.1:22\np2\nf3\nn127.0.0.1:48732\n')).toEqual([]);
  });

  it('returns [] when no uid field is present', () => {
    expect(parseLsofForUid('f3\nn127.0.0.1:48732\n')).toEqual([]);
  });

  it('returns [] on empty output', () => {
    expect(parseLsofForUid('')).toEqual([]);
  });
});

describe('resolveLoopbackListenerOwner', () => {
  const realPlatform = process.platform;

  function setPlatform(value: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value, configurable: true });
  }

  beforeEach(() => {
    readFileMock.mockReset();
    accessMock.mockReset();
    execFileMock.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  });

  it('linux: returns the owner uid of a loopback listener (/proc/net/tcp)', async () => {
    setPlatform('linux');
    readFileMock.mockImplementation(file =>
      file === '/proc/net/tcp' ? Promise.resolve(PROC_NET_TCP) : Promise.resolve(PROC_NET_TCP6_EMPTY)
    );
    await expect(resolveLoopbackListenerOwner(48732)).resolves.toEqual({ kind: 'owner', uid: 1000 });
  });

  it('linux: no matching row but tables readable => no-listener', async () => {
    setPlatform('linux');
    readFileMock.mockResolvedValue(PROC_NET_TCP6_EMPTY);
    await expect(resolveLoopbackListenerOwner(48732)).resolves.toEqual({ kind: 'no-listener' });
  });

  it('linux: neither table readable => unknown (fail-closed)', async () => {
    setPlatform('linux');
    readFileMock.mockRejectedValue(new Error('EACCES'));
    await expect(resolveLoopbackListenerOwner(48732)).resolves.toEqual({ kind: 'unknown' });
  });

  it('linux: two distinct owners across tables => unknown (ambiguous)', async () => {
    setPlatform('linux');
    const tcp6DifferentUid = PROC_NET_TCP6_LOOPBACK.replace('  1000 ', '  2000 ');
    readFileMock.mockImplementation(file =>
      file === '/proc/net/tcp' ? Promise.resolve(PROC_NET_TCP) : Promise.resolve(tcp6DifferentUid)
    );
    await expect(resolveLoopbackListenerOwner(48732)).resolves.toEqual({ kind: 'unknown' });
  });

  it('darwin: returns the owner uid from lsof output', async () => {
    setPlatform('darwin');
    accessMock.mockImplementation(path =>
      path === '/usr/sbin/lsof' ? Promise.resolve() : Promise.reject(new Error('ENOENT'))
    );
    execFileMock.mockImplementation((_file, _args, _opts, cb: (e: unknown, r: unknown) => void) =>
      cb(null, { stdout: 'p1234\nu501\nf3\nn127.0.0.1:48732\n', stderr: '' })
    );
    await expect(resolveLoopbackListenerOwner(48732)).resolves.toEqual({ kind: 'owner', uid: 501 });
  });

  it('darwin: lsof exits 1 with no output => no-listener', async () => {
    setPlatform('darwin');
    accessMock.mockResolvedValue(undefined);
    execFileMock.mockImplementation((_file, _args, _opts, cb: (e: unknown) => void) =>
      cb(Object.assign(new Error('no matches'), { code: 1, stdout: '' }))
    );
    await expect(resolveLoopbackListenerOwner(48732)).resolves.toEqual({ kind: 'no-listener' });
  });

  it('darwin: lsof missing on disk => unknown (fail-closed)', async () => {
    setPlatform('darwin');
    accessMock.mockRejectedValue(new Error('ENOENT'));
    await expect(resolveLoopbackListenerOwner(48732)).resolves.toEqual({ kind: 'unknown' });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('darwin: lsof times out (killed) => unknown (fail-closed)', async () => {
    setPlatform('darwin');
    accessMock.mockResolvedValue(undefined);
    execFileMock.mockImplementation((_file, _args, _opts, cb: (e: unknown) => void) =>
      cb(Object.assign(new Error('timed out'), { killed: true }))
    );
    await expect(resolveLoopbackListenerOwner(48732)).resolves.toEqual({ kind: 'unknown' });
  });

  it('unsupported platform => unknown (fail-closed)', async () => {
    setPlatform('win32');
    await expect(resolveLoopbackListenerOwner(48732)).resolves.toEqual({ kind: 'unknown' });
    expect(readFileMock).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

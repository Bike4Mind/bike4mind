import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from './__test__/helpers';
import { defaultSocketDir, defaultStateDir, dialCandidates, lookupGroupId, socketSpecs } from './paths';

describe('socketSpecs', () => {
  it('gives a system host one group-gated socket per role and a user host one socket for its owner', () => {
    expect(socketSpecs('system', '/run/b4m-host')).toEqual([
      { role: 'manage', path: '/run/b4m-host/manage.sock', group: 'b4m-host' },
      { role: 'admin', path: '/run/b4m-host/admin.sock', group: 'b4m-host-admin' },
    ]);
    expect(socketSpecs('user', '/run/user/1000/b4m-host')).toEqual([
      { role: 'admin', path: '/run/user/1000/b4m-host/admin.sock', group: null },
    ]);
  });
});

describe('default directories', () => {
  it('uses the systemd runtime and state directories, or the XDG ones for a user host', () => {
    const env = { XDG_RUNTIME_DIR: '/run/user/1000', XDG_STATE_HOME: '/home/u/.state' };
    expect(defaultSocketDir('system', env)).toBe('/run/b4m-host');
    expect(defaultStateDir('system', env)).toBe('/var/lib/b4m-host');
    expect(defaultSocketDir('user', env)).toBe('/run/user/1000/b4m-host');
    expect(defaultStateDir('user', env)).toBe('/home/u/.state/b4m-host');
  });
});

describe('dialCandidates', () => {
  it('tries admin before manage, and a system host before a user one', () => {
    expect(dialCandidates(undefined, { XDG_RUNTIME_DIR: '/run/user/1000' })).toEqual([
      '/run/b4m-host/admin.sock',
      '/run/b4m-host/manage.sock',
      '/run/user/1000/b4m-host/admin.sock',
    ]);
    expect(dialCandidates('/tmp/s')).toEqual(['/tmp/s/admin.sock', '/tmp/s/manage.sock']);
  });
});

describe('lookupGroupId', () => {
  it('reads the gid from a group file and returns null for a missing group or file', async () => {
    const { dir, cleanup } = await tempDir();
    const file = join(dir, 'group');
    await writeFile(file, 'root:x:0:\nb4m-host:x:998:alice,bob\nb4m-host-admin:x:997:\n');
    expect(await lookupGroupId('b4m-host', file)).toBe(998);
    expect(await lookupGroupId('b4m-host-admin', file)).toBe(997);
    expect(await lookupGroupId('b4m', file)).toBeNull();
    expect(await lookupGroupId('b4m-host', join(dir, 'missing'))).toBeNull();
    await cleanup();
  });
});

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSshHostsFile, sshHostsFile, UNREADABLE_COPY_SUFFIX, type SshHostRecord } from './sshHostsFile';

const host = (overrides: Partial<SshHostRecord> = {}): SshHostRecord => ({
  id: 'h1',
  reportedHostId: 'machine-a',
  aliases: ['devbox'],
  enabled: true,
  lastSeenAt: 42,
  installConsent: false,
  ...overrides,
});

describe('parseSshHostsFile', () => {
  it.each([undefined, null, 'text', { version: 2, hosts: [] }, { hosts: 'none' }])(
    'reads %j as an empty list',
    value => {
      expect(parseSshHostsFile(value)).toEqual({ version: 1, hosts: [] });
    }
  );

  it('keeps valid records and drops each bad one on its own', () => {
    const parsed = parseSshHostsFile({
      version: 1,
      hosts: [
        host(),
        host({ id: 'h2', aliases: ['-oProxyCommand=id'] }),
        { id: 'h3' },
        host({ id: 'h1', aliases: ['duplicate-id'] }),
        host({ id: 'h4', reportedHostId: null, lastSeenAt: null }),
      ],
    });
    expect(parsed.hosts.map(record => record.id)).toEqual(['h1', 'h4']);
    expect(parsed.hosts[0]).toEqual(host());
  });
});

describe('sshHostsFile', () => {
  let directory = '';
  let path = '';
  const logs: string[] = [];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'b4m-hosts-'));
    path = join(directory, 'hosts.json');
    logs.length = 0;
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('saves and loads the list, and starts empty without a file', async () => {
    const store = sshHostsFile(path, message => logs.push(message));
    expect(await store.load()).toEqual({ version: 1, hosts: [] });
    await store.update({ version: 1, hosts: [host()] });
    expect(await sshHostsFile(path, () => undefined).load()).toEqual({ version: 1, hosts: [host()] });
    expect(logs).toEqual([]);
  });

  it.each([
    ['a broken edit', '{ "version": 1, "hosts": [ }'],
    ['a newer version', JSON.stringify({ version: 2, hosts: [host()] })],
  ])('keeps a copy of %s before the first save replaces it', async (_what, text) => {
    await writeFile(path, text);
    const store = sshHostsFile(path, message => logs.push(message));

    expect(await store.load()).toEqual({ version: 1, hosts: [] });
    await store.update({ version: 1, hosts: [host({ id: 'h9' })] });

    expect(await readFile(`${path}${UNREADABLE_COPY_SUFFIX}`, 'utf8')).toBe(text);
    expect(logs).toEqual([expect.stringContaining('could not be read')]);
  });
});

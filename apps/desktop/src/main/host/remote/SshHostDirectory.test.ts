import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostConnectError, type HostConnectFailureKind } from '@shared/hostProtocol';
import { ACCOUNT, FakeHost } from '../__fixtures__/fakeHost';
import { ConnectionManager } from '../ConnectionManager';
import type { HostLinkTuning } from '../HostLink';
import { SshHostDirectory } from './SshHostDirectory';
import type { SshHostRecord, SshHostsFileContents } from './sshHostsFile';

const CLIENT = { clientId: 'client-1', clientName: 'Desktop', clientVersion: '1.0.0' };
const TUNING: Partial<HostLinkTuning> = { backoff: { baseMs: 1_000, capMs: 8_000 }, offlineAfterAttempts: 3 };
const NOW = 1_700_000_000_000;

const settle = () => vi.advanceTimersByTimeAsync(0);

const record = (overrides: Partial<SshHostRecord>): SshHostRecord => ({
  id: 'h1',
  reportedHostId: null,
  aliases: ['devbox'],
  enabled: true,
  lastSeenAt: null,
  installConsent: false,
  ...overrides,
});

const machine = (hostId: string): FakeHost => {
  const host = new FakeHost();
  host.hostId = hostId;
  return host;
};

function setUp(options: { records?: SshHostRecord[]; config?: string[] } = {}) {
  /** Which machine each alias reaches; an alias missing here fails as ssh would. */
  const routes = new Map<string, FakeHost | HostConnectFailureKind>();
  const opened: string[] = [];
  let saved: SshHostsFileContents = { version: 1, hosts: options.records ?? [] };
  const writes: SshHostsFileContents[] = [];
  const manager = new ConnectionManager({
    client: CLIENT,
    account: { current: () => ACCOUNT, onChanged: () => () => undefined },
    tuning: TUNING,
    random: () => 0,
    now: () => NOW,
  });
  let nextId = 1;
  const directory = new SshHostDirectory({
    manager,
    store: {
      load: async () => saved,
      update: async patch => {
        saved = { ...saved, ...patch };
        writes.push(saved);
        return saved;
      },
    },
    openTransport: async alias => {
      opened.push(alias);
      const route = routes.get(alias);
      if (route instanceof FakeHost) return route.connector.connect();
      throw new HostConnectError({ kind: route ?? 'sshFailed', detail: `ssh: ${alias}: no route`, stderrTail: '' });
    },
    listConfigHosts: async () => ({ aliases: options.config ?? ['devbox', 'devbox-vpn', 'other'], problems: [] }),
    now: () => NOW,
    newId: () => `new-${nextId++}`,
  });
  const state = (id: string) => manager.list().find(entry => entry.hostId === id)?.state;
  return { manager, directory, routes, opened, writes, saved: () => saved, state };
}

describe('SshHostDirectory', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds an alias from ~/.ssh/config, connects, and records the id the host reports', async () => {
    const { directory, routes, manager, saved, state } = setUp();
    routes.set('devbox', machine('machine-a'));
    await directory.load();

    const added = await directory.add('devbox');
    await settle();

    expect(added).toMatchObject({ id: 'new-1', aliases: ['devbox'], enabled: true, installConsent: false });
    expect(manager.list()).toEqual([expect.objectContaining({ hostId: 'new-1', label: 'devbox', kind: 'remote' })]);
    expect(state('new-1')).toMatchObject({ status: 'connected' });
    expect(saved().hosts).toEqual([
      expect.objectContaining({ id: 'new-1', reportedHostId: 'machine-a', lastSeenAt: NOW }),
    ]);
  });

  it('adds only aliases the config names, and an alias already known returns its host', async () => {
    const { directory, routes } = setUp();
    routes.set('devbox', machine('machine-a'));
    await directory.load();

    await expect(directory.add('not-in-config')).rejects.toThrow('not a host in ~/.ssh/config');
    const first = await directory.add('devbox');
    expect(await directory.add('devbox')).toEqual(first);
    expect(await directory.aliasEntries()).toEqual([
      { alias: 'devbox', hostId: first.id },
      { alias: 'devbox-vpn', hostId: null },
      { alias: 'other', hostId: null },
    ]);
  });

  it('a host that is not installed shows as needsInstall', async () => {
    const { directory, routes, state } = setUp();
    routes.set('devbox', 'notInstalled');
    await directory.load();
    await directory.add('devbox');
    await settle();
    expect(state('new-1')).toEqual({ status: 'needsInstall' });
  });

  it('merges a second alias that reaches a known machine into that host as another route', async () => {
    const { directory, routes, manager, saved, state } = setUp();
    const shared = machine('machine-a');
    routes.set('devbox', shared);
    routes.set('devbox-vpn', shared);
    await directory.load();
    await directory.add('devbox');
    await settle();

    await directory.add('devbox-vpn');
    await settle();

    expect(manager.list().map(entry => entry.hostId)).toEqual(['new-1']);
    expect(state('new-1')).toMatchObject({ status: 'connected' });
    expect(saved().hosts).toEqual([
      expect.objectContaining({ id: 'new-1', reportedHostId: 'machine-a', aliases: ['devbox', 'devbox-vpn'] }),
    ]);
    // The connection that found the duplicate was refused, so only the original host's stay open.
    expect(shared.open).toHaveLength(1);
  });

  it('moves an alias that now reaches another machine, and the host carries on over its other route', async () => {
    const { directory, routes, manager, saved, state } = setUp({
      records: [record({ reportedHostId: 'machine-a', aliases: ['devbox', 'devbox-vpn'] })],
    });
    const replaced = machine('machine-b');
    const original = machine('machine-a');
    routes.set('devbox', replaced);
    routes.set('devbox-vpn', original);

    await directory.load();
    await settle();
    expect(state('h1')).toMatchObject({ status: 'reconnecting' });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(state('h1')).toMatchObject({ status: 'connected', info: expect.objectContaining({ hostId: 'machine-a' }) });
    expect(state('new-1')).toMatchObject({
      status: 'connected',
      info: expect.objectContaining({ hostId: 'machine-b' }),
    });
    expect(manager.list().map(entry => entry.label)).toEqual(['devbox-vpn', 'devbox']);
    expect(saved().hosts).toEqual([
      expect.objectContaining({ id: 'h1', reportedHostId: 'machine-a', aliases: ['devbox-vpn'] }),
      expect.objectContaining({ id: 'new-1', reportedHostId: 'machine-b', aliases: ['devbox'] }),
    ]);
  });

  it('folds a host whose only alias now reaches a reinstalled machine into that machine, keeping consent', async () => {
    const { directory, routes, manager, saved, state } = setUp({
      records: [record({ reportedHostId: 'machine-a', installConsent: true })],
    });
    routes.set('devbox', machine('machine-a-reinstalled'));

    await directory.load();
    await settle();

    expect(manager.list().map(entry => [entry.hostId, entry.label])).toEqual([['new-1', 'devbox']]);
    expect(state('new-1')).toMatchObject({ status: 'connected' });
    expect(saved().hosts).toEqual([
      expect.objectContaining({
        id: 'new-1',
        reportedHostId: 'machine-a-reinstalled',
        aliases: ['devbox'],
        installConsent: true,
      }),
    ]);
  });

  it('re-adding the alias of a disconnected host connects it again', async () => {
    const { directory, routes, saved, state } = setUp({
      records: [record({ enabled: false, reportedHostId: 'machine-a' })],
    });
    routes.set('devbox', machine('machine-a'));
    await directory.load();

    await directory.add('devbox');
    await settle();

    expect(state('h1')).toMatchObject({ status: 'connected' });
    expect(saved().hosts[0]).toMatchObject({ enabled: true });
  });

  it('tries the next route after one fails', async () => {
    const { directory, routes, opened, state } = setUp({
      records: [record({ reportedHostId: 'machine-a', aliases: ['devbox', 'devbox-vpn'] })],
    });
    routes.set('devbox-vpn', machine('machine-a'));

    await directory.load();
    await settle();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(opened).toEqual(['devbox', 'devbox-vpn']);
    expect(state('h1')).toMatchObject({ status: 'connected' });
  });

  it('saves connect, disconnect and remove, and starts a disabled host offline at its last-seen time', async () => {
    const { directory, routes, manager, saved, state } = setUp({
      records: [record({ enabled: false, reportedHostId: 'machine-a', lastSeenAt: 42 })],
    });
    routes.set('devbox', machine('machine-a'));
    await directory.load();
    expect(state('h1')).toEqual({ status: 'offline', reason: 'disconnected', lastSeenAt: 42 });

    manager.connect('h1');
    await settle();
    expect(state('h1')).toMatchObject({ status: 'connected' });
    expect(saved().hosts[0]).toMatchObject({ enabled: true, lastSeenAt: NOW });

    manager.disconnect('h1');
    await settle();
    expect(saved().hosts[0]).toMatchObject({ enabled: false });

    manager.remove('h1');
    await settle();
    expect(saved().hosts).toEqual([]);
    expect(manager.list()).toEqual([]);
  });

  it('records install consent', async () => {
    const { directory, saved } = setUp({ records: [record({ enabled: false })] });
    await directory.load();
    await directory.setInstallConsent('h1', true);
    expect(saved().hosts[0]).toMatchObject({ installConsent: true });
    await expect(directory.setInstallConsent('missing', true)).rejects.toThrow('No SSH host missing');
  });
});

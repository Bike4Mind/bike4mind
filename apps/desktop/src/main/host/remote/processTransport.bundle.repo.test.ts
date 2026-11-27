import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HOST_PROTOCOL_VERSION,
  hostMethods,
  type EventCursor,
  type HostCloseReason,
  type HostNotification,
} from '@shared/hostProtocol';
import {
  buildHostBundle,
  E2E_USER_ID,
  seedSignedInVault,
  startFakeApi,
} from '../../../host/headless/__fixtures__/builtHost';
import { ConnectionManager } from '../ConnectionManager';
import { createProcessTransport, type ProcessSpec, type ProcessTransport } from './processTransport';
import { SshHostDirectory } from './SshHostDirectory';
import type { SshHostsFileContents } from './sshHostsFile';

/**
 * The SSH path without ssh: the process transport runs the BUILT `b4m-host connect` directly, as
 * ssh would run it on the remote machine, against a fake Bike4Mind API (see builtHost.ts).
 */

const describePosix = process.platform === 'win32' ? describe.skip : describe;

async function until(check: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

describePosix('the process transport against the built b4m-host', () => {
  const api = startFakeApi();
  let root = '';
  let bin = '';
  let dataDirectory = '';
  let apiUrl = '';
  const transports: ProcessTransport[] = [];

  /** `node b4m-host.cjs connect`, which is what `ssh <alias> b4m-host connect` runs on the far side. */
  const connectSpec = (): ProcessSpec => ({
    command: process.execPath,
    args: [bin, 'connect', '--data-dir', dataDirectory],
    env: { PATH: process.env.PATH ?? '', HOME: root, TMPDIR: root },
    cwd: root,
    label: 'loopback',
  });

  const open = async () => {
    const transport = await createProcessTransport(connectSpec());
    transports.push(transport);
    const notifications: HostNotification[] = [];
    transport.onNotification(notification => notifications.push(notification));
    const events = (sessionId: string) =>
      notifications
        .filter(notification => notification.method === 'session/event')
        .map(notification => notification.params as { sessionId: string; seq: number; event: { type: string } })
        .filter(params => params.sessionId === sessionId);
    return { transport, events };
  };

  const initialize = async (transport: ProcessTransport) =>
    hostMethods['host/initialize'].result.parse(
      await transport.request('host/initialize', {
        clientId: 'e2e',
        clientName: 'process transport e2e',
        clientVersion: '1',
        protocol: HOST_PROTOCOL_VERSION,
      })
    );

  beforeAll(async () => {
    apiUrl = await api.listen();
    root = await mkdtemp('/tmp/b4mh-pt-');
    dataDirectory = join(root, 'host');
    bin = await buildHostBundle(join(root, 'bin'), apiUrl);
    await seedSignedInVault(dataDirectory, apiUrl);
  }, 180_000);

  afterAll(async () => {
    for (const transport of transports) transport.close();
    if (bin.endsWith('.cjs')) {
      const { spawnSync } = await import('node:child_process');
      spawnSync(process.execPath, [bin, 'stop', '--data-dir', dataDirectory], {
        env: connectSpec().env,
        timeout: 30_000,
      });
    }
    await new Promise<void>(resolve => api.server.close(() => resolve()));
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('runs a turn, and resumes it from the cursor after the child is killed', async () => {
    const first = await open();
    const hello = await initialize(first.transport);
    expect(hello.account).toEqual({ userId: E2E_USER_ID, environmentUrl: apiUrl });

    const created = (await first.transport.request('session/create')) as { ok: boolean; session?: { id: string } };
    expect(created.ok).toBe(true);
    const sessionId = created.session?.id ?? '';
    const { cursor } = (await first.transport.request('session/subscribe', { sessionId })) as { cursor: EventCursor };
    expect(await first.transport.request('turn/send', { sessionId, text: 'Say hello' })).toMatchObject({ ok: true });
    await until(() => first.events(sessionId).some(event => event.event.type === 'delta'), 'the first delta');

    // The child dies mid-turn, as a dropped ssh would: the transport reports the host's side ending.
    const closed = new Promise<HostCloseReason>(resolve => first.transport.onClose(resolve));
    const pending = first.transport.request('host/info').catch((error: unknown) => error);
    process.kill(first.transport.pid ?? 0, 'SIGKILL');
    expect(await closed).toMatchObject({ initiator: 'host', failure: { kind: 'lost' } });
    expect(await pending).toMatchObject({ failure: { kind: 'lost' } });
    const seen = first.events(sessionId);

    api.releaseTurn();
    const second = await open();
    expect((await initialize(second.transport)).hostId).toBe(hello.hostId);
    const last = seen[seen.length - 1];
    await second.transport.request('session/subscribe', { sessionId, after: { epoch: cursor.epoch, seq: last.seq } });
    await until(() => second.events(sessionId).some(event => event.event.type === 'done'), 'the end of the turn');

    const seqs = [...seen, ...second.events(sessionId)].map(event => event.seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, index) => seqs[0] + index));
    expect(api.unexpected).toEqual([]);
  }, 120_000);

  it('connects a saved host through the directory and records the id the host reports', async () => {
    let saved: SshHostsFileContents = {
      version: 1,
      hosts: [
        {
          id: 'loopback',
          reportedHostId: null,
          aliases: ['loopback'],
          enabled: true,
          lastSeenAt: null,
          installConsent: false,
        },
      ],
    };
    const manager = new ConnectionManager({
      client: { clientId: 'e2e', clientName: 'Desktop e2e', clientVersion: '1' },
      account: { current: () => ({ userId: E2E_USER_ID, environmentUrl: apiUrl }), onChanged: () => () => undefined },
    });
    const directory = new SshHostDirectory({
      manager,
      store: {
        load: async () => saved,
        update: async patch => {
          saved = { ...saved, ...patch };
          return saved;
        },
      },
      openTransport: async () => {
        const transport = await createProcessTransport(connectSpec());
        transports.push(transport);
        return transport;
      },
      listConfigHosts: async () => ({ aliases: ['loopback'], problems: [] }),
    });
    try {
      await directory.load();
      await until(() => manager.list()[0]?.state.status === 'connected', 'the host to connect');
      expect(saved.hosts[0].reportedHostId).toEqual(expect.any(String));
      expect(saved.hosts[0].lastSeenAt).toEqual(expect.any(Number));
    } finally {
      directory.dispose();
      manager.dispose();
    }
  }, 60_000);
});

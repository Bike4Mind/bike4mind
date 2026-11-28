import { describe, expect, it, vi } from 'vitest';
import type { HostInstallProgressEvent, HostRunningWork } from '@shared/hostConnection';
import { HostConnectError, type HostTransport } from '@shared/hostProtocol';
import { hostInfo } from '../../__fixtures__/fakeHost';
import { HostNeedsUserError } from '../../handshake';
import type { HostArtifact } from './hostArtifact';
import { HostInstallError } from './HostInstaller';
import type { HostProbe } from './hostProbe';
import { HostProvisioner, queryRunningWork, type HostProvisionerOptions } from './HostProvisioner';

const VERSION = '2.0.0';
const ARTIFACT: HostArtifact = {
  version: VERSION,
  tarballPath: '/tmp/b4m-host.tar.gz',
  size: 10,
  sha256: 'a'.repeat(64),
};

const machine = (overrides: Partial<HostProbe> = {}): HostProbe => ({
  os: 'Linux',
  arch: 'x86_64',
  hasTar: true,
  node: { path: '/usr/bin/node', version: 'v24.1.0', major: 24 },
  installedVersions: ['1.0.0'],
  launcher: { state: 'works', version: '1.0.0' },
  daemon: { state: 'none' },
  ...overrides,
});

const BUSY: HostRunningWork = {
  kind: 'sessions',
  sessions: [{ sessionId: 's1', status: 'processing', backgroundJobs: 0 }],
};

function setup(probe: HostProbe, options: { consent?: boolean; work?: HostRunningWork } = {}) {
  const installer = {
    probe: vi.fn(async () => probe),
    install: vi.fn(async () => undefined),
    activate: vi.fn(async () => undefined),
    stopDaemon: vi.fn(async () => undefined),
  };
  const consent = { value: options.consent ?? false };
  const progress: HostInstallProgressEvent[] = [];
  const reconnect = vi.fn();
  const runningWork = vi.fn(async () => options.work ?? { kind: 'sessions' as const, sessions: [] });
  const settings: HostProvisionerOptions = {
    installer,
    artifact: async () => ARTIFACT,
    version: VERSION,
    hosts: {
      installTarget: hostId => (hostId === 'h1' ? { alias: 'box', installConsent: consent.value } : null),
      setInstallConsent: async (_hostId, value) => {
        consent.value = value;
      },
    },
    reconnect,
    runningWork,
    onProgress: event => progress.push(event),
    log: () => undefined,
  };
  const provisioner = new HostProvisioner(settings);
  const phases = () => progress.map(event => event.progress.phase);
  return { provisioner, installer, consent, reconnect, runningWork, phases };
}

describe('HostProvisioner.beforeConnect', () => {
  it('lets a host at this version connect, and probes it once', async () => {
    const { provisioner, installer } = setup(machine({ launcher: { state: 'works', version: VERSION } }));
    await provisioner.beforeConnect('h1', 'box');
    await provisioner.beforeConnect('h1', 'box');
    expect(installer.probe).toHaveBeenCalledTimes(1);
    expect(installer.install).not.toHaveBeenCalled();
  });

  it('waits for the user on a machine without the host program', async () => {
    const { provisioner, installer } = setup(machine({ launcher: { state: 'absent' }, installedVersions: [] }), {
      consent: true,
    });
    const error = await provisioner.beforeConnect('h1', 'box').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HostNeedsUserError);
    expect((error as HostNeedsUserError).state).toEqual({ status: 'needsInstall' });
    expect(installer.install).not.toHaveBeenCalled();
  });

  it('updates quietly when no daemon runs and the user agreed to installs', async () => {
    const { provisioner, installer, phases } = setup(machine(), { consent: true });
    await provisioner.beforeConnect('h1', 'box');
    expect(installer.install).toHaveBeenCalledWith('box', ARTIFACT, expect.anything(), expect.any(Function));
    expect(installer.activate).not.toHaveBeenCalled();
    expect(phases()).toEqual(['preparing', 'done']);
    await provisioner.beforeConnect('h1', 'box');
    expect(installer.probe).toHaveBeenCalledTimes(1);
  });

  it('waits for the user on another version without consent', async () => {
    const { provisioner, installer } = setup(machine());
    await expect(provisioner.beforeConnect('h1', 'box')).rejects.toMatchObject({
      state: { status: 'needsUpdate', required: false },
    });
    expect(installer.install).not.toHaveBeenCalled();
  });

  it.each([
    ['of another version', { state: 'running', version: '1.0.0' }],
    ['whose version cannot be read', { state: 'unknown' }],
  ] as const)('connects to a running daemon %s as it is, consent or not', async (_name, daemon) => {
    const { provisioner, installer } = setup(machine({ daemon }), { consent: true });
    await expect(provisioner.beforeConnect('h1', 'box')).resolves.toBeUndefined();
    await provisioner.beforeConnect('h1', 'box');
    expect(installer.probe).toHaveBeenCalledTimes(1);
    expect(installer.install).not.toHaveBeenCalled();
    expect(installer.stopDaemon).not.toHaveBeenCalled();
  });

  it('marks the update required when the active build cannot run', async () => {
    const { provisioner } = setup(machine({ launcher: { state: 'fails', exitCode: 9 } }));
    await expect(provisioner.beforeConnect('h1', 'box')).rejects.toMatchObject({
      state: { status: 'needsUpdate', required: true },
    });
  });

  it('waits for the user when a quiet update fails', async () => {
    const { provisioner, installer, phases } = setup(machine(), { consent: true });
    installer.install.mockRejectedValueOnce(
      new HostInstallError({ kind: 'installFailed', detail: 'disk full', stderrTail: '' })
    );
    await expect(provisioner.beforeConnect('h1', 'box')).rejects.toBeInstanceOf(HostNeedsUserError);
    expect(phases()).toEqual(['preparing', 'failed']);
  });

  it('retries a quiet update that failed on ssh', async () => {
    const { provisioner, installer } = setup(machine(), { consent: true });
    installer.install.mockRejectedValueOnce(
      new HostInstallError({ kind: 'sshFailed', detail: 'reset', stderrTail: '' })
    );
    const error = await provisioner.beforeConnect('h1', 'box').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HostConnectError);
    expect((error as HostConnectError).failure.kind).toBe('sshFailed');
  });

  it('fails a machine without the host program that cannot install it', async () => {
    const { provisioner } = setup(
      machine({
        node: { path: '/usr/bin/node', version: 'v20.0.0', major: 20 },
        launcher: { state: 'absent' },
        installedVersions: [],
      })
    );
    const error = await provisioner.beforeConnect('h1', 'box').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HostConnectError);
    expect((error as HostConnectError).failure.kind).toBe('nodeTooOld');
  });

  it.each([
    ['missing', null],
    ['too old', { path: '/usr/bin/node', version: 'v22.1.0', major: 22 }],
  ] as const)(
    'connects to a running daemon of another version when the login shell Node.js is %s',
    async (_name, node) => {
      const { provisioner, installer } = setup(machine({ node, daemon: { state: 'running', version: '1.0.0' } }), {
        consent: true,
      });
      await expect(provisioner.beforeConnect('h1', 'box')).resolves.toBeUndefined();
      expect(installer.install).not.toHaveBeenCalled();
    }
  );

  it('connects to an installed build whose own Node.js still runs when the login shell one changed', async () => {
    const { provisioner, installer } = setup(
      machine({ node: { path: '/usr/bin/node', version: 'v22.1.0', major: 22 } }),
      {
        consent: true,
      }
    );
    await expect(provisioner.beforeConnect('h1', 'box')).resolves.toBeUndefined();
    expect(installer.install).not.toHaveBeenCalled();
  });

  it('fails a broken installed build on a machine that cannot install', async () => {
    const { provisioner } = setup(machine({ node: null, launcher: { state: 'fails', exitCode: 9 } }), {
      consent: true,
    });
    const error = await provisioner.beforeConnect('h1', 'box').catch((caught: unknown) => caught);
    expect((error as HostConnectError).failure.kind).toBe('nodeMissing');
  });

  it('retries when ssh fails, and connects anyway when the probe answer is unreadable', async () => {
    const { provisioner, installer } = setup(machine());
    installer.probe.mockRejectedValueOnce(
      new HostInstallError({ kind: 'sshFailed', detail: 'timeout', stderrTail: '' })
    );
    const error = await provisioner.beforeConnect('h1', 'box').catch((caught: unknown) => caught);
    expect((error as HostConnectError).failure.kind).toBe('sshFailed');

    installer.probe.mockRejectedValueOnce(
      new HostInstallError({ kind: 'probeFailed', detail: 'garbled', stderrTail: '' })
    );
    await expect(provisioner.beforeConnect('h1', 'box')).resolves.toBeUndefined();
    await provisioner.beforeConnect('h1', 'box');
    expect(installer.probe).toHaveBeenCalledTimes(2);
  });
});

describe('HostProvisioner.install and update', () => {
  it('records consent on install, installs, and reconnects', async () => {
    const { provisioner, installer, consent, reconnect, phases } = setup(
      machine({ launcher: { state: 'absent' }, installedVersions: [] })
    );
    await expect(provisioner.install('h1')).resolves.toEqual({
      status: 'installed',
      version: VERSION,
      restarted: false,
    });
    expect(consent.value).toBe(true);
    expect(installer.install).toHaveBeenCalledWith('box', ARTIFACT, expect.anything(), expect.any(Function), {
      activate: true,
    });
    expect(installer.activate).not.toHaveBeenCalled();
    expect(installer.stopDaemon).not.toHaveBeenCalled();
    expect(reconnect).toHaveBeenCalledWith('h1');
    expect(phases()).toEqual(['preparing', 'probing', 'done']);
  });

  it('reports a host already at this version as up to date', async () => {
    const { provisioner, installer, reconnect } = setup(machine({ launcher: { state: 'works', version: VERSION } }));
    await expect(provisioner.update('h1', { force: false })).resolves.toEqual({ status: 'upToDate', version: VERSION });
    expect(installer.install).not.toHaveBeenCalled();
    expect(reconnect).toHaveBeenCalledWith('h1');
  });

  it('never installs this older build over a newer host program', async () => {
    const { provisioner, installer, runningWork } = setup(
      machine({ launcher: { state: 'works', version: '3.0.0' }, daemon: { state: 'running', version: '3.0.0' } })
    );
    await expect(provisioner.update('h1', { force: true })).resolves.toEqual({ status: 'upToDate', version: '3.0.0' });
    expect(installer.install).not.toHaveBeenCalled();
    expect(installer.stopDaemon).not.toHaveBeenCalled();
    expect(runningWork).not.toHaveBeenCalled();
  });

  it('connects to a newer host program without a quiet downgrade', async () => {
    const { provisioner, installer } = setup(machine({ launcher: { state: 'works', version: '3.0.0' } }), {
      consent: true,
    });
    await provisioner.beforeConnect('h1', 'box');
    expect(installer.install).not.toHaveBeenCalled();
  });

  it('returns the running work and changes nothing without confirmation', async () => {
    const { provisioner, installer, reconnect } = setup(machine({ daemon: { state: 'running', version: '1.0.0' } }), {
      work: BUSY,
    });
    await expect(provisioner.update('h1', { force: false })).resolves.toEqual({
      status: 'confirmationRequired',
      work: BUSY,
    });
    expect(installer.install).not.toHaveBeenCalled();
    expect(installer.stopDaemon).not.toHaveBeenCalled();
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('keeps a version staged when work starts during the upload, and the host connectable', async () => {
    const daemon = { state: 'running', version: '1.0.0' } as const;
    const { provisioner, installer, runningWork } = setup(machine({ daemon }));
    await provisioner.beforeConnect('h1', 'box');
    runningWork.mockResolvedValueOnce({ kind: 'sessions', sessions: [] }).mockResolvedValueOnce(BUSY);
    await expect(provisioner.update('h1', { force: false })).resolves.toEqual({
      status: 'confirmationRequired',
      work: BUSY,
    });
    expect(installer.install).toHaveBeenCalledWith('box', ARTIFACT, expect.anything(), expect.any(Function), {
      activate: false,
    });
    expect(installer.activate).not.toHaveBeenCalled();
    expect(installer.stopDaemon).not.toHaveBeenCalled();
    await provisioner.beforeConnect('h1', 'box');
    expect(installer.probe).toHaveBeenCalledTimes(2);
  });

  it('asks for confirmation when the running work cannot be listed', async () => {
    const { provisioner, installer } = setup(machine({ daemon: { state: 'running', version: '1.0.0' } }), {
      work: { kind: 'unknown' },
    });
    await expect(provisioner.update('h1', { force: false })).resolves.toMatchObject({ status: 'confirmationRequired' });
    expect(installer.install).not.toHaveBeenCalled();
  });

  it('restarts an idle daemon without asking', async () => {
    const { provisioner, installer, runningWork, phases } = setup(
      machine({ daemon: { state: 'running', version: '1.0.0' } })
    );
    await expect(provisioner.update('h1', { force: false })).resolves.toEqual({
      status: 'installed',
      version: VERSION,
      restarted: true,
    });
    expect(installer.stopDaemon).toHaveBeenCalledWith('box');
    // Staged, the work asked for again right before the switch, then activated and stopped.
    expect(installer.install).toHaveBeenCalledWith('box', ARTIFACT, expect.anything(), expect.any(Function), {
      activate: false,
    });
    const order = (mock: { mock: { invocationCallOrder: number[] } }) => mock.mock.invocationCallOrder;
    const [, secondQuery] = order(runningWork);
    expect(order(installer.install)[0]).toBeLessThan(secondQuery);
    expect(secondQuery).toBeLessThan(order(installer.activate)[0]);
    expect(order(installer.activate)[0]).toBeLessThan(order(installer.stopDaemon)[0]);
    expect(installer.activate).toHaveBeenCalledWith('box', VERSION, expect.anything(), expect.any(Function));
    expect(phases()).toEqual(['preparing', 'probing', 'restarting', 'done']);
  });

  it('interrupts running work only with force, without asking again', async () => {
    const { provisioner, installer, runningWork } = setup(machine({ daemon: { state: 'running', version: '1.0.0' } }), {
      work: BUSY,
    });
    await expect(provisioner.update('h1', { force: true })).resolves.toMatchObject({
      status: 'installed',
      restarted: true,
    });
    expect(runningWork).not.toHaveBeenCalled();
    expect(installer.install.mock.invocationCallOrder[0]).toBeLessThan(installer.activate.mock.invocationCallOrder[0]);
    expect(installer.activate.mock.invocationCallOrder[0]).toBeLessThan(
      installer.stopDaemon.mock.invocationCallOrder[0]
    );
  });

  it('only restarts when this version is already active behind an older daemon', async () => {
    const { provisioner, installer } = setup(
      machine({ launcher: { state: 'works', version: VERSION }, daemon: { state: 'running', version: '1.0.0' } })
    );
    await expect(provisioner.update('h1', { force: false })).resolves.toMatchObject({
      status: 'installed',
      restarted: true,
    });
    expect(installer.install).not.toHaveBeenCalled();
    expect(installer.activate).not.toHaveBeenCalled();
    expect(installer.stopDaemon).toHaveBeenCalled();
  });

  it('ends in failed with the reason when the old daemon will not stop after the switch', async () => {
    const old = machine({ daemon: { state: 'running', version: '1.0.0' } });
    const { provisioner, installer, reconnect, phases } = setup(old);
    await provisioner.beforeConnect('h1', 'box');
    const refusal = {
      kind: 'installFailed' as const,
      detail: 'Could not stop the host on box (it timed out)',
      stderrTail: 'busy',
    };
    installer.stopDaemon.mockRejectedValueOnce(new HostInstallError(refusal));

    await expect(provisioner.update('h1', { force: false })).resolves.toEqual({ status: 'failed', failure: refusal });
    expect(phases().slice(-2)).toEqual(['restarting', 'failed']);
    expect(reconnect).not.toHaveBeenCalled();

    // The next connection probes again: this version is active behind the old daemon, so it goes
    // ahead and the launcher's version check answers it (daemonVersionMismatch: needsUpdate).
    installer.probe.mockResolvedValue({ ...old, launcher: { state: 'works', version: VERSION } });
    await expect(provisioner.beforeConnect('h1', 'box')).resolves.toBeUndefined();
    expect(installer.probe).toHaveBeenCalledTimes(3);
    expect(installer.install).toHaveBeenCalledTimes(1);

    // A second update only restarts.
    await expect(provisioner.update('h1', { force: false })).resolves.toMatchObject({
      status: 'installed',
      restarted: true,
    });
    expect(installer.install).toHaveBeenCalledTimes(1);
    expect(installer.stopDaemon).toHaveBeenCalledTimes(2);
  });

  it('reports a Node.js blocker on update and leaves the host usable on its build', async () => {
    const old = machine({ node: null, daemon: { state: 'running', version: '1.0.0' } });
    const { provisioner, installer, runningWork, reconnect } = setup(old);
    await provisioner.beforeConnect('h1', 'box');
    await expect(provisioner.update('h1', { force: false })).resolves.toMatchObject({
      status: 'failed',
      failure: { kind: 'nodeMissing', detail: expect.stringContaining('login shell') },
    });
    expect(runningWork).not.toHaveBeenCalled();
    expect(installer.install).not.toHaveBeenCalled();
    expect(installer.stopDaemon).not.toHaveBeenCalled();
    expect(reconnect).not.toHaveBeenCalled();
    await provisioner.beforeConnect('h1', 'box');
    expect(installer.probe).toHaveBeenCalledTimes(2);
  });

  it('restarts behind an active build even when the login shell Node.js changed', async () => {
    const { provisioner, installer } = setup(
      machine({
        node: null,
        launcher: { state: 'works', version: VERSION },
        daemon: { state: 'running', version: '1.0.0' },
      })
    );
    await expect(provisioner.update('h1', { force: false })).resolves.toMatchObject({
      status: 'installed',
      restarted: true,
    });
    expect(installer.stopDaemon).toHaveBeenCalled();
  });

  it('reports failures as a result and as progress', async () => {
    const { provisioner, installer, phases } = setup(machine({ hasTar: false }));
    await expect(provisioner.update('h1', { force: false })).resolves.toMatchObject({
      status: 'failed',
      failure: { kind: 'unsupportedPlatform' },
    });
    expect(installer.install).not.toHaveBeenCalled();
    expect(phases().at(-1)).toBe('failed');
  });

  it('reports a missing artifact as artifactUnavailable', async () => {
    const { installer } = setup(machine());
    const provisioner = new HostProvisioner({
      installer,
      artifact: async () => {
        throw new Error('The host program is missing from this Desktop');
      },
      version: VERSION,
      hosts: {
        installTarget: () => ({ alias: 'box', installConsent: true }),
        setInstallConsent: async () => undefined,
      },
      reconnect: () => undefined,
      runningWork: async () => ({ kind: 'unknown' }),
      onProgress: () => undefined,
      log: () => undefined,
    });
    await expect(provisioner.update('h1', { force: false })).resolves.toMatchObject({
      status: 'failed',
      failure: { kind: 'artifactUnavailable', detail: 'The host program is missing from this Desktop' },
    });
  });

  it('rejects for a host it has no alias for, recording no consent', async () => {
    const { provisioner, consent } = setup(machine());
    await expect(provisioner.update('other', { force: false })).rejects.toThrow('no SSH alias');
    await expect(provisioner.install('other')).rejects.toThrow('no SSH alias');
    expect(consent.value).toBe(false);
  });

  it('runs one call per host at a time; a connection waits for an install in flight', async () => {
    const { provisioner, installer } = setup(machine({ launcher: { state: 'absent' }, installedVersions: [] }));
    let finish: () => void = () => undefined;
    installer.install.mockImplementationOnce(
      () => new Promise<undefined>(resolve => (finish = () => resolve(undefined)))
    );

    const install = provisioner.install('h1');
    await vi.waitFor(() => expect(installer.install).toHaveBeenCalledTimes(1));
    const connect = provisioner.beforeConnect('h1', 'box');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(installer.probe).toHaveBeenCalledTimes(1);

    finish();
    await install;
    await expect(connect).resolves.toBeUndefined();
    // The install left the host ready, so the connection needed no probe of its own.
    expect(installer.probe).toHaveBeenCalledTimes(1);
  });
});

describe('queryRunningWork', () => {
  const CLIENT = { clientId: 'c', clientName: 'Desktop', clientVersion: VERSION };
  const log = () => undefined;

  function transport(answers: Record<string, () => unknown>) {
    const close = vi.fn();
    const link: HostTransport = {
      request: async method => {
        const answer = answers[method];
        if (!answer) throw new Error(`unexpected ${method}`);
        return answer();
      },
      onNotification: () => () => undefined,
      onClose: () => () => undefined,
      close,
    };
    return { link, close };
  }

  const initialize = () => hostInfo();

  it('lists the sessions with work running and closes its connection', async () => {
    const { link, close } = transport({
      'host/initialize': initialize,
      'session/statuses': () => ({
        statuses: [
          { sessionId: 'a', status: 'processing' },
          { sessionId: 'b', status: 'done' },
          { sessionId: 'c', status: 'done', background: { running: 2, label: 'npm test' } },
          { sessionId: 'd', status: 'needs-action' },
        ],
      }),
    });
    const work = await queryRunningWork(async () => link, CLIENT, 1_000, log);
    expect(work).toEqual({
      kind: 'sessions',
      sessions: [
        { sessionId: 'a', status: 'processing', backgroundJobs: 0 },
        { sessionId: 'c', status: 'done', backgroundJobs: 2 },
        { sessionId: 'd', status: 'needs-action', backgroundJobs: 0 },
      ],
    });
    expect(close).toHaveBeenCalled();
  });

  it('is unknown when the daemon cannot be reached or will not list its sessions', async () => {
    await expect(
      queryRunningWork(async () => Promise.reject(new Error('ssh failed')), CLIENT, 1_000, log)
    ).resolves.toEqual({ kind: 'unknown' });
    const refusing = transport({
      'host/initialize': initialize,
      'session/statuses': () => {
        throw new Error('not signed in');
      },
    });
    await expect(queryRunningWork(async () => refusing.link, CLIENT, 1_000, log)).resolves.toEqual({ kind: 'unknown' });
    expect(refusing.close).toHaveBeenCalled();
  });
});

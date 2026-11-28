import type { ChatSessionStatusEvent } from '@shared/chat';
import type {
  HostBusySession,
  HostInstallFailure,
  HostInstallProgress,
  HostInstallProgressEvent,
  HostInstallResult,
  HostRunningWork,
} from '@shared/hostConnection';
import {
  HOST_CONNECT_FAILURE_KINDS,
  HostConnectError,
  hostMethods,
  type HostConnectFailure,
  type HostTransport,
} from '@shared/hostProtocol';
import { HostNeedsUserError, initializeHost, withTimeout, type ClientIdentity } from '../../handshake';
import type { HostArtifact } from './hostArtifact';
import { HostInstallError, type HostInstaller } from './HostInstaller';
import { installBlocker, type HostProbe } from './hostProbe';

/** Where a host is installed to: the alias its next connection goes through, and whether the user agreed to installs. */
export type HostInstallTarget = { alias: string; installConsent: boolean };

export type HostProvisionerOptions = {
  installer: Pick<HostInstaller, 'probe' | 'install' | 'activate' | 'stopDaemon'>;
  /** This Desktop's copy of the host program; rejects when it has none it can use. */
  artifact(): Promise<HostArtifact>;
  /** This Desktop's version: the one it installs and connects to. */
  version: string;
  hosts: {
    installTarget(hostId: string): HostInstallTarget | null;
    setInstallConsent(hostId: string, consent: boolean): Promise<void>;
  };
  /** Starts connecting to the host now (ConnectionManager.connect). */
  reconnect(hostId: string): void;
  /** What the daemon `alias` reaches is doing; see queryRunningWork. */
  runningWork(alias: string): Promise<HostRunningWork>;
  onProgress(event: HostInstallProgressEvent): void;
  log(message: string): void;
};

const CONNECT_FAILURE_KINDS: ReadonlySet<string> = new Set(HOST_CONNECT_FAILURE_KINDS);

function asConnectFailure(failure: HostInstallFailure): HostConnectFailure | null {
  const { kind } = failure;
  return isConnectFailureKind(kind) ? { ...failure, kind } : null;
}

function isConnectFailureKind(kind: string): kind is HostConnectFailure['kind'] {
  return CONNECT_FAILURE_KINDS.has(kind);
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const failureOf = (error: unknown): HostInstallFailure =>
  error instanceof HostInstallError
    ? error.failure
    : { kind: 'installFailed', detail: messageOf(error), stderrTail: '' };

/** A daemon of another version, or one whose version could not be read, is still running. */
const otherDaemonRuns = (probe: HostProbe, version: string): boolean =>
  probe.daemon.state === 'unknown' || (probe.daemon.state === 'running' && probe.daemon.version !== version);

const activeIs = (probe: HostProbe, version: string): boolean =>
  probe.launcher.state === 'works' && probe.launcher.version === version;

/**
 * Keeps a remote machine's host program at this Desktop's version, and decides when that may
 * happen without asking. Before each connection (`beforeConnect`) it checks the machine once per
 * run: a missing install waits for the user (`needsInstall`). With another version installed, a
 * running daemon is connected to as it is (the handshake decides whether its protocol fits, and
 * the UI compares `hostVersion`); with no daemon, the install is replaced quietly when the user
 * has agreed to installs on that host, and otherwise waits for the user (`needsUpdate`).
 * `install` and `update` are the user's answers. An update never stops a daemon with work running
 * unless the caller passes `force` after seeing that work.
 *
 * Calls for one host run one at a time, so a connection attempt waits for an install in flight
 * rather than racing it; a second Desktop is kept out by the installer's remote lock.
 */
export class HostProvisioner {
  /** Hosts checked at this version since they were last installed or updated by this run. */
  private readonly ready = new Set<string>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly options: HostProvisionerOptions) {}

  /**
   * Called by the host's connector before it opens a connection through `alias`, outside the
   * connect timeout (the probe and the install have bounds of their own, HostInstallerTimeouts);
   * a quiet install reports install progress while the host shows `connecting` or `reconnecting`.
   * Resolves when the connection may go ahead; rejects with HostConnectError (ssh failed: retried;
   * the machine cannot run the host program: failed) or HostNeedsUserError. A probe answer it cannot read lets the
   * connection go ahead, so the connection itself reports what is wrong.
   */
  beforeConnect(hostId: string, alias: string): Promise<void> {
    return this.serialized(hostId, () => this.check(hostId, alias));
  }

  /** Records the user's consent to installs on the host, then installs or updates it as `update` does. */
  async install(hostId: string): Promise<HostInstallResult> {
    if (!this.options.hosts.installTarget(hostId))
      throw new Error(`Host ${hostId} has no SSH alias to install through`);
    await this.options.hosts.setInstallConsent(hostId, true);
    return this.update(hostId, { force: false });
  }

  /**
   * Brings the host to this Desktop's version. When a daemon of another version runs, the new
   * version is unpacked beside the active one first and its work asked for right before anything
   * changes: with work running (or none it can list) nothing more happens and the work is returned
   * (`confirmationRequired`) unless `force`; otherwise the new version is activated, the daemon
   * stopped and the host reconnected. Never rejects for a failure on the machine: that is the
   * `failed` result, also reported as progress.
   */
  update(hostId: string, options: { force: boolean }): Promise<HostInstallResult> {
    return this.serialized(hostId, () => this.bringUpToDate(hostId, options.force));
  }

  private async check(hostId: string, alias: string): Promise<void> {
    if (this.ready.has(hostId)) return;
    const { installer, version } = this.options;
    let probe: HostProbe;
    try {
      probe = await installer.probe(alias);
    } catch (error) {
      const failure = failureOf(error);
      if (failure.kind === 'sshFailed') throw new HostConnectError({ ...failure, kind: 'sshFailed' });
      this.options.log(`HOST ${hostId}: connecting without a probe: ${failure.detail}`);
      this.ready.add(hostId);
      return;
    }
    if (activeIs(probe, version)) {
      this.ready.add(hostId);
      return;
    }
    // The blocker judges the Node.js the login shell finds now, which only an install uses; the
    // launcher and a daemon it started run the Node.js written into the launcher at install time.
    const blocker = installBlocker(probe, alias);
    const blocking = blocker && asConnectFailure(blocker);
    if (probe.launcher.state === 'absent') {
      if (blocking) throw new HostConnectError(blocking);
      throw new HostNeedsUserError({ status: 'needsInstall' });
    }
    if (probe.daemon.state !== 'none' || (blocker && probe.launcher.state === 'works')) {
      // A daemon of another version, or an older build that still runs where no install can:
      // connect to it as it is rather than stop its work or refuse a host that works.
      if (blocker) this.options.log(`HOST ${hostId}: connecting to the installed host program; ${blocker.detail}`);
      this.ready.add(hostId);
      return;
    }
    if (blocking) throw new HostConnectError(blocking);

    const consent = this.options.hosts.installTarget(hostId)?.installConsent === true;
    if (consent) {
      const failure = await this.installQuietly(hostId, alias, probe);
      if (!failure) return;
      if (failure.kind === 'sshFailed') throw new HostConnectError({ ...failure, kind: 'sshFailed' });
    }
    // The active build cannot run at all, so the host cannot be used until it is updated.
    throw new HostNeedsUserError({ status: 'needsUpdate', required: probe.launcher.state !== 'works' });
  }

  /** An update nobody asked for: no daemon runs and the user agreed to installs. Null when it worked. */
  private async installQuietly(hostId: string, alias: string, probe: HostProbe): Promise<HostInstallFailure | null> {
    const emit = this.emitter(hostId);
    try {
      emit({ phase: 'preparing' });
      const artifact = await this.artifact();
      await this.options.installer.install(alias, artifact, probe, emit);
      this.ready.add(hostId);
      emit({ phase: 'done', version: artifact.version });
      this.options.log(`HOST ${hostId}: updated the host program on ${alias} to ${artifact.version}`);
      return null;
    } catch (error) {
      const failure = failureOf(error);
      emit({ phase: 'failed', failure });
      this.options.log(`HOST ${hostId}: could not update the host program on ${alias}: ${failure.detail}`);
      return failure;
    }
  }

  private async bringUpToDate(hostId: string, force: boolean): Promise<HostInstallResult> {
    const target = this.options.hosts.installTarget(hostId);
    if (!target) throw new Error(`Host ${hostId} has no SSH alias to install through`);
    const { alias } = target;
    const { installer, version } = this.options;
    const emit = this.emitter(hostId);
    try {
      emit({ phase: 'preparing' });
      const artifact = await this.artifact();
      emit({ phase: 'probing' });
      const probe = await installer.probe(alias);
      const active = activeIs(probe, version);
      const restart = otherDaemonRuns(probe, version);
      // Only an install needs the login shell's Node.js; nothing has changed yet, so the host
      // stays usable on the build it has.
      const blocker = active ? null : installBlocker(probe, alias);
      if (blocker) throw new HostInstallError(blocker);
      if (active && !restart) {
        this.ready.add(hostId);
        emit({ phase: 'done', version });
        this.options.reconnect(hostId);
        return { status: 'upToDate', version };
      }
      const confirmation = async (): Promise<HostInstallResult | null> => {
        if (!restart || force) return null;
        const work = await this.options.runningWork(alias);
        return work.kind === 'unknown' || work.sessions.length > 0 ? { status: 'confirmationRequired', work } : null;
      };
      const before = await confirmation();
      if (before) return before;

      // From here the machine changes; the next connection checks it again if this fails.
      const wasReady = this.ready.delete(hostId);
      if (!active) await installer.install(alias, artifact, probe, emit, { activate: !restart });
      if (restart) {
        // Work may have started during the upload; the new version stays unpacked if it has.
        const after = await confirmation();
        if (after) {
          // The active version has not changed, so neither has what a connection reaches.
          if (wasReady) this.ready.add(hostId);
          return after;
        }
        if (!active) await installer.activate(alias, version, probe, emit);
        emit({ phase: 'restarting' });
        await installer.stopDaemon(alias);
      }
      this.ready.add(hostId);
      emit({ phase: 'done', version });
      this.options.log(`HOST ${hostId}: installed the host program ${version} on ${alias}`);
      this.options.reconnect(hostId);
      return { status: 'installed', version, restarted: restart };
    } catch (error) {
      const failure = failureOf(error);
      emit({ phase: 'failed', failure });
      this.options.log(`HOST ${hostId}: installing on ${alias} failed: ${failure.detail}`);
      return { status: 'failed', failure };
    }
  }

  private async artifact(): Promise<HostArtifact> {
    try {
      return await this.options.artifact();
    } catch (error) {
      throw new HostInstallError({ kind: 'artifactUnavailable', detail: messageOf(error), stderrTail: '' });
    }
  }

  private emitter(hostId: string): (progress: HostInstallProgress) => void {
    return progress => this.options.onProgress({ hostId, progress });
  }

  private serialized<T>(hostId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(hostId) ?? Promise.resolve();
    const run = previous.then(task);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.queues.set(hostId, tail);
    void tail.then(() => {
      if (this.queues.get(hostId) === tail) this.queues.delete(hostId);
    });
    return run;
  }
}

/** A session an update would interrupt: a turn running or waiting on the user, or background commands still running. */
function busySessions(statuses: readonly ChatSessionStatusEvent[]): HostBusySession[] {
  return statuses
    .map(status => ({
      sessionId: status.sessionId,
      status: status.status,
      backgroundJobs: status.background?.running ?? 0,
    }))
    .filter(session => session.status !== 'done' || session.backgroundJobs > 0);
}

/**
 * Asks the daemon `open` reaches which of its sessions have work running, over a connection of
 * its own that it closes again. `unknown` when the daemon cannot be asked: the connection or the
 * handshake fails (another protocol major), or it will not list its sessions.
 */
export async function queryRunningWork(
  open: () => Promise<HostTransport>,
  client: ClientIdentity,
  timeoutMs: number,
  log: (message: string) => void
): Promise<HostRunningWork> {
  let transport: HostTransport;
  try {
    transport = await open();
  } catch (error) {
    log(`HOST: could not reach the running daemon to list its work: ${messageOf(error)}`);
    return { kind: 'unknown' };
  }
  try {
    const handshake = await initializeHost(transport, client, timeoutMs);
    if (!handshake.ok) {
      log('HOST: the running daemon did not accept a connection to list its work');
      return { kind: 'unknown' };
    }
    const raw = await withTimeout(transport.request('session/statuses', {}), timeoutMs, 'session/statuses');
    const parsed = hostMethods['session/statuses'].result.safeParse(raw);
    if (!parsed.success) {
      log('HOST: the running daemon listed its sessions in a shape this Desktop does not read');
      return { kind: 'unknown' };
    }
    return { kind: 'sessions', sessions: busySessions(parsed.data.statuses) };
  } catch (error) {
    log(`HOST: could not list the running daemon's work: ${messageOf(error)}`);
    return { kind: 'unknown' };
  } finally {
    transport.close();
  }
}

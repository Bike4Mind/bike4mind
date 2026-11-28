import type { ChatSessionStatus } from './chat';
import type { HostConnectFailure, HostResult } from './hostProtocol';

/** What `host/initialize` and `host/info` report about a host. */
export type HostInfo = HostResult<'host/info'>;
export type HostAccount = HostInfo['account'];

/**
 * Why a host is offline. `disconnected`: the user turned it off. `signedOut`: Desktop has no
 * account to connect remote hosts with. Neither retries on its own. `noNetwork`: retried once the
 * network is back. `unreachable`: connecting kept failing; retried at the slowest backoff.
 */
export type HostOfflineReason = 'disconnected' | 'signedOut' | 'noNetwork' | 'unreachable';

/**
 * Where Desktop's link to one host stands. Only `connected` serves session requests; a request to
 * a host in any other state fails at once with capabilityUnavailable. `needsSignIn` and
 * `accountMismatch` have a live control connection, so the `host/*` methods (sign-in among them)
 * still reach the host.
 *
 * `needsUpdate.required` is false when the installed host differs from this Desktop's and nothing
 * runs on it, so updating interrupts nothing; true when the two speak different protocol majors,
 * or when the installed host cannot run at all.
 * A connected host of another version that still speaks this major stays `connected`; compare
 * `info.hostVersion` to show that an update is available.
 */
export type HostConnectionState =
  | { status: 'connecting' }
  | { status: 'connected'; info: HostInfo; latencyMs: number }
  | { status: 'reconnecting'; attempt: number; nextRetryAt: number }
  | { status: 'offline'; reason: HostOfflineReason; lastSeenAt: number | null }
  | { status: 'needsInstall' }
  | { status: 'needsUpdate'; required: boolean }
  | { status: 'needsSignIn' }
  | { status: 'accountMismatch'; hostAccount: NonNullable<HostAccount> }
  | { status: 'failed'; failure: HostConnectFailure };

export type HostConnectionStatus = HostConnectionState['status'];

/** `local` is the machine Desktop runs on; it is never removed and never needs an account check. */
export type HostKind = 'local' | 'remote';

export type HostEntry = {
  hostId: string;
  label: string;
  kind: HostKind;
  state: HostConnectionState;
  /** Whether the user agreed to installs and updates of the host program on this host; remote hosts only. */
  installConsent?: boolean;
};

/** An alias from the user's `~/.ssh/config`; `hostId` is the host it is a route to, once added. */
export type SshAliasEntry = { alias: string; hostId: string | null };

/** What `ssh -G` resolves an alias to, without connecting. */
export type SshAliasDescription = { alias: string; hostname: string; user: string; port: number };

/**
 * Managing the hosts themselves, beside the protocol bridge. `onStateChanged` sends the whole
 * list on every change, a removal included. connect, disconnect and remove reject for a host
 * that is not registered; remove also rejects for the local host.
 */
export type HostConnectionsApi = {
  list(): Promise<HostEntry[]>;
  onStateChanged(listener: (hosts: HostEntry[]) => void): () => void;
  /** Connects now, skipping any backoff wait; a no-op for a connected host. */
  connect(hostId: string): Promise<void>;
  /** Closes every connection to the host and keeps it offline until connect. */
  disconnect(hostId: string): Promise<void>;
  remove(hostId: string): Promise<void>;
  /** The concrete Host aliases of `~/.ssh/config` (no patterns), in file order. */
  sshAliases(): Promise<SshAliasEntry[]>;
  describeSshAlias(alias: string): Promise<SshAliasDescription>;
  /**
   * Adds the machine an alias of `sshAliases` reaches and starts connecting; resolves with its
   * hostId. An alias that is already a route resolves with its host's id. A machine without the
   * host program installed shows as `needsInstall`.
   */
  addSshHost(alias: string): Promise<string>;
};

/**
 * Why installing or updating the host program on a machine failed: a connection failure kind
 * (`nodeMissing`, `nodeTooOld` and `unsupportedPlatform` say what the machine lacks), or one of
 * the installer's own. `probeFailed`: the machine's answer to the probe could not be read.
 * `installBusy`: another install to the same machine held its lock for too long.
 * `installFailed`: a step on the machine failed; `stderrTail` says which. `artifactUnavailable`:
 * this Desktop has no usable copy of the host program to install.
 */
export type HostInstallFailureKind =
  HostConnectFailure['kind'] | 'probeFailed' | 'installBusy' | 'installFailed' | 'artifactUnavailable';
export type HostInstallFailure = { kind: HostInstallFailureKind; detail: string; stderrTail: string };

/**
 * One step of an install or update, in order: `preparing` (finding this Desktop's copy of the
 * host program; building it, in a source run), `probing` the machine, `uploading`, `verifying`
 * the uploaded build, `activating` it, `restarting` (stopping the old daemon and reconnecting,
 * only when one ran), then `done` or `failed`. An update that stops for confirmation reports no
 * last phase: its result (`confirmationRequired`) says so.
 */
export type HostInstallProgress =
  | { phase: 'preparing' }
  | { phase: 'probing' }
  | { phase: 'uploading'; sentBytes: number; totalBytes: number }
  | { phase: 'verifying' }
  | { phase: 'activating' }
  | { phase: 'restarting' }
  | { phase: 'done'; version: string }
  | { phase: 'failed'; failure: HostInstallFailure };

export type HostInstallProgressEvent = { hostId: string; progress: HostInstallProgress };

/** A session whose work an update would interrupt: a turn running or waiting on the user, or background commands. */
export type HostBusySession = { sessionId: string; status: ChatSessionStatus; backgroundJobs: number };

/**
 * What a running daemon is doing. `unknown` when it cannot be asked: it speaks another protocol
 * major, so its sessions cannot be listed.
 */
export type HostRunningWork = { kind: 'sessions'; sessions: HostBusySession[] } | { kind: 'unknown' };

/**
 * `force`: the user agreed to interrupt the work a `confirmationRequired` answer reported. Without
 * it, an update never stops a daemon that has work running.
 */
export type HostUpdateOptions = { force: boolean };

/**
 * `installed`: this Desktop's version is now the machine's host program; `restarted` when an
 * older daemon was stopped for it. `upToDate`: it already was, and nothing changed.
 * `confirmationRequired`: a daemon with work running would have to stop; nothing changed.
 */
export type HostInstallResult =
  | { status: 'installed'; version: string; restarted: boolean }
  | { status: 'upToDate'; version: string }
  | { status: 'confirmationRequired'; work: HostRunningWork }
  | { status: 'failed'; failure: HostInstallFailure };

/**
 * Installing and updating the host program on a remote machine over SSH. Both resolve, never
 * reject, for a registered remote host; progress arrives through `onInstallProgress` meanwhile.
 * One install or update runs per host at a time; a second call waits for the first.
 */
export type HostInstallApi = {
  /**
   * Records the user's consent to install and update the host program on this machine (kept in
   * `hosts.json`; later updates that interrupt nothing then run without asking), and installs
   * this Desktop's version.
   */
  install(hostId: string): Promise<HostInstallResult>;
  /** Installs this Desktop's version over another one; see HostUpdateOptions for running work. */
  update(hostId: string, options: HostUpdateOptions): Promise<HostInstallResult>;
  onInstallProgress(listener: (event: HostInstallProgressEvent) => void): () => void;
};

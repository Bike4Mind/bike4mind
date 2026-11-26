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
 * runs on it, so updating interrupts nothing; true when the two speak different protocol majors.
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

export type HostEntry = { hostId: string; label: string; kind: HostKind; state: HostConnectionState };

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
};

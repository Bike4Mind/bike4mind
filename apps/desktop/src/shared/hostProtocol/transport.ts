import type { HostError, HostNotification } from './envelope';

/** A host answered a request with a JSON-RPC error; `code` is one of HOST_ERROR_CODES. */
export class HostRequestError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(error: HostError) {
    super(error.message);
    this.name = 'HostRequestError';
    this.code = error.code;
    this.data = error.data;
  }

  toHostError(): HostError {
    return { code: this.code, message: this.message, ...(this.data === undefined ? {} : { data: this.data }) };
  }
}

/**
 * Why a connection to a host could not be opened, or why an open one ended. `kind` says what the
 * user can do about it; `detail` is the message to show, and `stderrTail` the last of what the
 * host process wrote to stderr (empty when there is none, as for the in-process host).
 */
export const HOST_CONNECT_FAILURE_KINDS = [
  'sshFailed',
  'notInstalled',
  'nodeMissing',
  'nodeTooOld',
  'unsupportedPlatform',
  'daemonStartTimeout',
  'daemonVersionMismatch',
  'protocolMismatch',
  'lost',
] as const;
export type HostConnectFailureKind = (typeof HOST_CONNECT_FAILURE_KINDS)[number];
export type HostConnectFailure = { kind: HostConnectFailureKind; detail: string; stderrTail: string };

/** A connector's rejection, and a transport's rejection of the requests pending when it closed. */
export class HostConnectError extends Error {
  readonly failure: HostConnectFailure;

  constructor(failure: HostConnectFailure) {
    super(failure.detail);
    this.name = 'HostConnectError';
    this.failure = failure;
  }
}

/** `client`: this side called close(). `host`: the host or the link to it went away. */
export type HostCloseReason = { initiator: 'client' } | { initiator: 'host'; failure: HostConnectFailure };

/**
 * One client's connection to one host. A transport moves JSON-RPC envelopes and pairs each
 * response with its request; it knows nothing about the methods. The in-process transport
 * (src/host/server) and the SSH stdio transport both implement it, so a caller cannot tell a
 * local host from a remote one.
 *
 * Messages arrive in the order the host sent them, responses and notifications alike. Once the
 * connection ends, every pending and later request rejects with HostConnectError and no
 * notification is delivered.
 */
export type HostTransport = {
  /** Resolves with the response's `result`; rejects with HostRequestError when the host answers with an error. */
  request(method: string, params?: unknown): Promise<unknown>;
  onNotification(listener: (notification: HostNotification) => void): () => void;
  /** Called once, when the connection ends for either side's reason. */
  onClose(listener: (reason: HostCloseReason) => void): () => void;
  /** Ends the connection; the host drops what it held for it, its session subscriptions included. */
  close(): void;
};

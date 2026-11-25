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
 * One client's connection to one host. A transport moves JSON-RPC envelopes and pairs each
 * response with its request; it knows nothing about the methods. The in-process transport
 * (src/host/server) and the SSH stdio transport both implement it, so a caller cannot tell a
 * local host from a remote one.
 */
export type HostTransport = {
  /** Resolves with the response's `result`; rejects with HostRequestError when the host answers with an error. */
  request(method: string, params?: unknown): Promise<unknown>;
  onNotification(listener: (notification: HostNotification) => void): () => void;
  /** Ends the connection; the host drops what it held for it, its session subscriptions included. */
  close(): void;
};

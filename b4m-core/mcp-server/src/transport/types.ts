import type { OperationName } from './operations';

export interface TransportRequest {
  params?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
}

/** A non-2xx is a normal response here, not an exception; only network-level failures throw. */
export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  json?: unknown;
  bytes?: Uint8Array;
  /** Target of a 3xx; it is reported, never followed. */
  redirect?: string;
}

/** The seam between the tools and a deployment. Stdio calls over HTTP; the hosted server dispatches in-process. */
export interface ApiTransport {
  call(operation: OperationName, request?: TransportRequest): Promise<TransportResponse>;
}

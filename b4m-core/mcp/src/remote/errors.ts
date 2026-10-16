export type RemoteMcpErrorCode =
  | 'invalid_url'
  | 'ssrf_blocked'
  | 'timeout'
  | 'auth_required'
  | 'auth_failed'
  | 'protocol'
  | 'size_cap'
  | 'upstream_5xx';

/** Base class for every failure `RemoteMcpClient` surfaces; `code` is stable and safe to show or log. */
export class RemoteMcpError extends Error {
  readonly code: RemoteMcpErrorCode;

  constructor(code: RemoteMcpErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RemoteMcpError';
    this.code = code;
  }
}

export type RemoteMcpUrlRejection =
  'malformed' | 'scheme' | 'userinfo' | 'ip_literal' | 'internal_hostname' | 'own_host' | 'port';

export class RemoteMcpInvalidUrlError extends RemoteMcpError {
  readonly reason: RemoteMcpUrlRejection;

  constructor(reason: RemoteMcpUrlRejection, message: string) {
    super('invalid_url', message);
    this.name = 'RemoteMcpInvalidUrlError';
    this.reason = reason;
  }
}

export class RemoteMcpSsrfBlockedError extends RemoteMcpError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('ssrf_blocked', message, options);
    this.name = 'RemoteMcpSsrfBlockedError';
  }
}

export class RemoteMcpTimeoutError extends RemoteMcpError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('timeout', message, options);
    this.name = 'RemoteMcpTimeoutError';
  }
}

/** A 401. The challenge fields feed OAuth discovery (RFC 9728 `resource_metadata`, requested `scope`). */
export class RemoteMcpAuthRequiredError extends RemoteMcpError {
  readonly resourceMetadataUrl?: string;
  readonly scope?: string;
  readonly wwwAuthenticate?: string;

  constructor(challenge: { resourceMetadataUrl?: string; scope?: string; wwwAuthenticate?: string }) {
    super('auth_required', 'The MCP server requires authorization');
    this.name = 'RemoteMcpAuthRequiredError';
    this.resourceMetadataUrl = challenge.resourceMetadataUrl;
    this.scope = challenge.scope;
    this.wwwAuthenticate = challenge.wwwAuthenticate;
  }
}

/** A 403: credentials were presented and refused (including `insufficient_scope`). */
export class RemoteMcpAuthFailedError extends RemoteMcpError {
  readonly scope?: string;

  constructor(message: string, scope?: string) {
    super('auth_failed', message);
    this.name = 'RemoteMcpAuthFailedError';
    this.scope = scope;
  }
}

export class RemoteMcpProtocolError extends RemoteMcpError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('protocol', message, options);
    this.name = 'RemoteMcpProtocolError';
  }
}

export class RemoteMcpSizeCapError extends RemoteMcpError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('size_cap', message, options);
    this.name = 'RemoteMcpSizeCapError';
  }
}

export class RemoteMcpUpstreamError extends RemoteMcpError {
  readonly status: number;

  constructor(status: number, options?: { cause?: unknown }) {
    super('upstream_5xx', `The MCP server returned HTTP ${status}`, options);
    this.name = 'RemoteMcpUpstreamError';
    this.status = status;
  }
}

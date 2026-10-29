/** A saved server answered 401: the user has to enter new credentials, not retry. */
export class ServerCredentialsError extends Error {
  constructor(
    readonly serverLabel: string,
    readonly hadCredentials: boolean
  ) {
    super(
      hadCredentials
        ? `${serverLabel} rejected the credentials Desktop sent. Enter new ones under Settings, Model servers.`
        : `${serverLabel} asks for credentials. Add a token or header under Settings, Model servers.`
    );
    this.name = 'ServerCredentialsError';
  }
}

/**
 * A saved server answered 403. Not a credentials prompt: Ollama answers 403 to a Host header it does not
 * expect, and proxies and allowlists use 403 for a blocked client.
 */
export class ServerForbiddenError extends Error {
  constructor(readonly serverLabel: string) {
    super(`${serverLabel} answered 403 Forbidden: the server or a proxy in front of it refused the request.`);
    this.name = 'ServerForbiddenError';
  }
}

/** A saved server could not be reached, or dropped the connection. Names the server. */
export class ServerUnreachableError extends Error {
  constructor(serverLabel: string, reason: string, options?: { cause?: unknown }) {
    super(`Could not reach ${serverLabel}: ${reason}`, options);
    this.name = 'ServerUnreachableError';
  }
}

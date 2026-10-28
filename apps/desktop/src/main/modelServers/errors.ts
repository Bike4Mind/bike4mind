/** A saved server answered 401 or 403: the user has to enter new credentials, not retry. */
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

/** A saved server could not be reached, or dropped the connection. Names the server. */
export class ServerUnreachableError extends Error {
  constructor(serverLabel: string, reason: string, options?: { cause?: unknown }) {
    super(`Could not reach ${serverLabel}: ${reason}`, options);
    this.name = 'ServerUnreachableError';
  }
}

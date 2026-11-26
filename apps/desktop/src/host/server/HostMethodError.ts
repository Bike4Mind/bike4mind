/** A failure a handler means to send as-is, rather than as an internal error. */
export class HostMethodError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message);
  }
}

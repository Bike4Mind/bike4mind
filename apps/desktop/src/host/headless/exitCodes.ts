/** `b4m-host` exit codes. A client over SSH tells the failures apart by these, so they never change meaning. */
export const HOST_EXIT_CODES = {
  ok: 0,
  failure: 1,
  usage: 2,
  unsupportedPlatform: 3,
  nodeTooOld: 4,
  /** The running daemon is another build; replacing it is the client's decision. */
  daemonVersionMismatch: 5,
  daemonStartTimeout: 6,
  daemonAlreadyRunning: 7,
  /** The daemon closed the connection while stdin was still open. */
  daemonConnectionLost: 8,
  /** The launcher Desktop installs found no Node.js at the path it was written with. */
  nodeMissing: 9,
} as const;
export type HostExitCode = (typeof HOST_EXIT_CODES)[keyof typeof HOST_EXIT_CODES];

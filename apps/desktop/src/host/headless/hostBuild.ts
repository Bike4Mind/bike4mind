// Substituted by vite.host.config.ts; absent when the source runs under a test runner.
declare const __B4M_HOST_VERSION__: string | undefined;

/** The version of this `b4m-host` build, which a daemon and the `connect` talking to it must share. */
export const HOST_BUILD_VERSION: string =
  typeof __B4M_HOST_VERSION__ === 'string' ? __B4M_HOST_VERSION__ : '0.0.0-source';

export const MINIMUM_NODE_MAJOR = 24;

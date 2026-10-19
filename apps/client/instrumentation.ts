/**
 * Next.js Instrumentation
 *
 * This file is called once when a new Next.js server instance is initiated.
 * Node.js-specific setup (error handlers, model logging) lives in
 * instrumentation.node.ts to avoid Turbopack resolution issues with
 * workspace packages in the edge/client bundle.
 *
 * @see https://nextjs.org/docs/app/guides/instrumentation
 */
export async function register() {
  // Fail the server at boot on a malformed TRUSTED_PROXY_HOPS; otherwise getClientIp throws inside
  // the logging middleware and every baseApi route serves a 500.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { readTrustedProxyHops } = await import('./server/utils/trustedClientIpHeaders');
    readTrustedProxyHops();
  }
}

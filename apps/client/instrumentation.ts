/**
 * Next.js Instrumentation
 *
 * Called once when a new Next.js server instance starts. Next only loads this file;
 * it does NOT pick up instrumentation.node.ts on its own. The Node-only setup lives
 * there and is imported dynamically under the nodejs runtime guard so its workspace
 * packages stay out of the edge bundle.
 *
 * @see https://nextjs.org/docs/app/guides/instrumentation
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Fail the server at boot on a malformed TRUSTED_PROXY_HOPS; otherwise getClientIp throws inside
    // the logging middleware and every baseApi route serves a 500.
    const { readTrustedProxyHops } = await import('./server/utils/trustedClientIpHeaders');
    readTrustedProxyHops();

    const { register: registerNode } = await import('./instrumentation.node');
    registerNode();
  }
}

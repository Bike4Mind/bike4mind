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
  // Node.js-specific instrumentation is in instrumentation.node.ts
}

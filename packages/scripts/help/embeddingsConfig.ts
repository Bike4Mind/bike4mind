/**
 * Deploy-time policy for the help embedding step.
 *
 * Kept in its own module rather than inside vectorize-help-content.ts so tests can
 * cover it without importing that script's @bike4mind/fab-pipeline dependency - the
 * docs-only CI leg runs help/__tests__ with no core build on purpose.
 */

/**
 * Whether a missing OPENAI_API_KEY or a failed embedding run must fail the build.
 *
 * Defaults to true when unset, so a manual `help:regenerate` and any pipeline that
 * has not opted out keep today's hard failure. Environments where keyword search is
 * the intended outcome (previews, self-host) set HELP_EMBEDDINGS_REQUIRED=false and
 * degrade to the fallback path in apps/client/server/help/retrieval.ts.
 */
export function helpEmbeddingsRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.HELP_EMBEDDINGS_REQUIRED?.trim().toLowerCase();
  return raw !== 'false' && raw !== '0';
}

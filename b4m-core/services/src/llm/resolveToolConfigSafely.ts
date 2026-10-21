import type { Logger } from '@bike4mind/observability';

/** A job tool's config resolver failing must drop that one tool, never the turn. */
export async function resolveToolConfigSafely<TConfig>(
  toolName: string,
  resolve: (() => Promise<TConfig | null>) | undefined,
  logger: Logger
): Promise<TConfig | null> {
  if (!resolve) return null;
  try {
    return await resolve();
  } catch (error) {
    logger.warn(`${toolName} unavailable: capability resolution failed`, error);
    return null;
  }
}

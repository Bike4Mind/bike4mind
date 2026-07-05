/**
 * Generic per-surface chat-context seam.
 *
 * Some product surfaces enrich every chat send with extra system context - a
 * view description for the navigate_view tool, and/or an "active brief" the
 * model should target when the user says "edit this". Core owns only the
 * registration seam; a surface registers a provider at module import (side
 * effect), and the two chat send paths (LLMCommand and the REST
 * pushChatMessage) read whatever is registered. A fork with no registered
 * providers gets core's neutral defaults.
 */

export interface SurfaceChatContext {
  /** One-line description of the current view for navigate_view awareness. */
  viewDescription?: string | null;
  /** Full system-message content describing the surface's active brief. */
  briefContext?: string | null;
}

export type SurfaceChatContextProvider = () => SurfaceChatContext;

const providers = new Set<SurfaceChatContextProvider>();

/** Register a surface's provider. Returns an unregister function. */
export function registerSurfaceChatContextProvider(provider: SurfaceChatContextProvider): () => void {
  providers.add(provider);
  return () => providers.delete(provider);
}

/**
 * Merge all registered providers (first non-null value per field wins).
 * Providers are expected to return {} when their surface is not active.
 */
export function getSurfaceChatContext(): SurfaceChatContext {
  const merged: SurfaceChatContext = {};
  for (const provider of providers) {
    const ctx = provider();
    if (merged.viewDescription == null && ctx.viewDescription != null) merged.viewDescription = ctx.viewDescription;
    if (merged.briefContext == null && ctx.briefContext != null) merged.briefContext = ctx.briefContext;
  }
  return merged;
}

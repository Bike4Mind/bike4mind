import type { AuthState } from '@shared/auth';
import type { ChatModelOption } from '@shared/chat';
import type { ModelRuntimeStatus } from '@shared/models';

export interface NoLocalModels {
  reason: string;
  /** Set when the Models screen is the way out; absent when Ollama itself has to be started. */
  fix: 'open-models' | null;
}

/** Signed out by choice, as opposed to an account whose session expired (which keeps its hosted models). */
export function isLocalMode(auth: AuthState | null | undefined): boolean {
  return !!auth && auth.status !== 'signed-in' && !auth.reauthRequired;
}

/**
 * Why signed-out chat cannot send, or null while it can or does not know yet. Ollama down (even
 * with models listed) and Ollama up with no model need different fixes, so they read differently.
 */
export function noLocalModels(catalog: {
  models: readonly ChatModelOption[];
  loading: boolean;
  runtime?: ModelRuntimeStatus | null;
}): NoLocalModels | null {
  const { models, loading, runtime } = catalog;
  if (models.some(model => model.server && !model.unavailable)) return null;
  const down = (): NoLocalModels => ({
    reason: `Ollama is not running at ${runtime?.url ?? 'its default address'}. Start it (open the Ollama app or run "ollama serve"); this checks again every few seconds.`,
    fix: null,
  });
  if (runtime && !runtime.reachable) return down();
  if (models.length > 0 || loading) return null;
  if (!runtime) return down();
  return {
    reason: 'Ollama is running but has no models that can chat. Install one from the Models screen.',
    fix: 'open-models',
  };
}

/** The banner text for a send the composer must block: the local-mode reason, else the attachment one. */
export function composerBlock(noLocal: NoLocalModels | null, attachmentReason: string | null) {
  return {
    reason: noLocal?.reason ?? attachmentReason,
    action: noLocal?.fix === 'open-models' ? ('open-models' as const) : null,
  };
}

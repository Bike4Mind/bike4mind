import type { AuthState } from '@shared/auth';
import type { ChatModelOption } from '@shared/chat';
import type { ModelRuntimeStatus } from '@shared/models';
import { OLLAMA_NOT_RUNNING, OLLAMA_START_HINT } from '../models/localRuntimeCopy';

export interface NoLocalModels {
  reason: string;
  /** `open-models` when the Models screen is the way out; `start-ollama` when Ollama itself has to be started. */
  fix: 'open-models' | 'start-ollama';
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
  if (models.some(model => model.server && (!model.unavailable || model.pending))) return null;
  const down = (): NoLocalModels => ({
    reason: `${OLLAMA_NOT_RUNNING}. ${OLLAMA_START_HINT}`,
    fix: 'start-ollama',
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

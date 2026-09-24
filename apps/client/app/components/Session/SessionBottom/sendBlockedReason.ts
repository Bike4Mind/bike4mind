import type { TFunction } from 'i18next';

export type SendBlockedReason =
  'generating' | 'sending' | 'loadingModels' | 'modelsError' | 'noModels' | 'reconnecting' | 'uploading';

/**
 * Why the composer can't send right now, or null when it can. The single gate for the Send
 * button, Enter-to-send and voice-to-send, so they can never disagree about whether a send
 * is allowed. Input emptiness is not a reason: an empty composer shows no Send button.
 */
export function getSendBlockedReason(params: {
  isGenerating: boolean;
  submitting: boolean;
  isModelsLoading: boolean;
  isModelsError: boolean;
  hasModels: boolean;
  isSocketOpen: boolean;
  hasActiveUploads: boolean;
}): SendBlockedReason | null {
  if (params.isGenerating) return 'generating';
  if (params.submitting) return 'sending';
  if (params.isModelsLoading) return 'loadingModels';
  if (!params.hasModels) return params.isModelsError ? 'modelsError' : 'noModels';
  if (!params.isSocketOpen) return 'reconnecting';
  if (params.hasActiveUploads) return 'uploading';
  return null;
}

/** User-facing text for a blocked reason; shared by the Send tooltip and the blocked-send toast. */
export function getSendBlockedLabel(reason: SendBlockedReason, t: TFunction): string {
  switch (reason) {
    case 'generating':
      return t('session.sendBlocked.generating', 'A response is still generating');
    case 'sending':
      return t('session.sendBlocked.sending', 'Sending...');
    case 'loadingModels':
      return t('session.loadingModels', 'Loading AI models\u2026');
    case 'modelsError':
      return t('session.sendBlocked.modelsError', "Couldn't load AI models");
    case 'noModels':
      return t('session.sendBlocked.noModels', 'No models available');
    case 'reconnecting':
      return t('session.sendBlocked.reconnecting', 'Reconnecting...');
    case 'uploading':
      return t('session.sendBlocked.uploading', 'Uploading files...');
  }
}

// 'generating' and 'sending' are already obvious from the Stop button / spinner.
const TOASTED_REASONS: ReadonlySet<SendBlockedReason> = new Set([
  'loadingModels',
  'modelsError',
  'noModels',
  'reconnecting',
  'uploading',
]);

export const BLOCKED_SEND_TOAST_WINDOW_MS = 3_000;

/**
 * Returns a predicate saying whether a blocked Enter should toast its reason now: only for
 * reasons the UI doesn't already show, and at most once per reason per window.
 */
export function createBlockedSendToastGate(windowMs = BLOCKED_SEND_TOAST_WINDOW_MS) {
  const lastShownAt = new Map<SendBlockedReason, number>();
  return (reason: SendBlockedReason, now = Date.now()): boolean => {
    if (!TOASTED_REASONS.has(reason)) return false;
    const last = lastShownAt.get(reason);
    if (last !== undefined && now - last < windowMs) return false;
    lastShownAt.set(reason, now);
    return true;
  };
}

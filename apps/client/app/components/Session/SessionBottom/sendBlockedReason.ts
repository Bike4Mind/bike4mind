export type SendBlockedReason = 'generating' | 'sending' | 'loadingModels' | 'noModels' | 'reconnecting' | 'uploading';

/**
 * Why the composer can't send right now, or null when it can. The single gate for the Send
 * button, Enter-to-send and voice-to-send, so they can never disagree about whether a send
 * is allowed. Input emptiness is not a reason: an empty composer shows no Send button.
 */
export function getSendBlockedReason(params: {
  isGenerating: boolean;
  submitting: boolean;
  isModelsLoading: boolean;
  hasModels: boolean;
  isSocketOpen: boolean;
  hasActiveUploads: boolean;
}): SendBlockedReason | null {
  if (params.isGenerating) return 'generating';
  if (params.submitting) return 'sending';
  if (params.isModelsLoading) return 'loadingModels';
  if (!params.hasModels) return 'noModels';
  if (!params.isSocketOpen) return 'reconnecting';
  if (params.hasActiveUploads) return 'uploading';
  return null;
}

export interface ComposerCreditUi {
  /** Out of credits: CreditsWarning takes the place of the message box. */
  replaceComposer: boolean;
  /** Low but not out: the dismissible notice overlays the message box. */
  lowCreditsNotice: boolean;
  /** Send and voice are disabled in the toolbar. */
  toolbarBlocked: boolean;
}

/**
 * What the composer shows for the credit balance. The single gate for the out-of-credits
 * block, the low-credits notice and the toolbar, so they can never disagree.
 *
 * Without models there is nothing to send with, and NoModelsWarning covers the box, so
 * neither credit notice is shown then - but the toolbar still blocks an exhausted balance.
 */
export function getComposerCreditUi(params: {
  enforceCredits: boolean;
  effectiveCredits: number;
  /** A voice session ran the balance out; it counts as exhausted whatever the number says. */
  exhaustedByVoice: boolean;
  hasModels: boolean;
  lowWarningDismissed: boolean;
  lowThreshold: number;
}): ComposerCreditUi {
  const { enforceCredits, effectiveCredits, exhaustedByVoice, hasModels } = params;
  const exhausted = effectiveCredits <= 0 || exhaustedByVoice;
  const low = !exhausted && effectiveCredits < params.lowThreshold;
  return {
    replaceComposer: enforceCredits && exhausted && hasModels,
    lowCreditsNotice: enforceCredits && low && hasModels && !params.lowWarningDismissed,
    toolbarBlocked: enforceCredits && exhausted,
  };
}

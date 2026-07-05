import { ModelName, PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';

interface ValidateChatInputParams {
  inputText: string;
  accessibleModels: { id: ModelName }[] | undefined;
  maxInputTokens: number;
  effectiveMaxOutputTokens: number;
  currentUser: { currentCredits?: number; emailVerified?: boolean | null; tags?: string[] | null } | null;
  effectiveCredits: number;
  enforceCredits: boolean;
}

/**
 * Validates chat input and returns an error message string if invalid, or null if valid.
 */
export function validateChatInput({
  inputText,
  accessibleModels,
  maxInputTokens,
  effectiveMaxOutputTokens,
  currentUser,
  effectiveCredits,
  enforceCredits,
}: ValidateChatInputParams): string | null {
  if (!accessibleModels || accessibleModels.length === 0) {
    return "You don't have access to any AI models. Please contact your administrator to request the appropriate permissions.";
  } else if (maxInputTokens <= 0) {
    // contextWindowLimit is 0 - the selected model isn't in modelInfo (still loading,
    // or no model selected). Surface that directly instead of the misleading
    // "Input exceeds maximum allowed (0 tokens)" message the next branch produces.
    return 'No AI model selected. Please pick a model in AI Settings before sending.';
  } else if (inputText.length > maxInputTokens) {
    return `Input exceeds maximum allowed (${maxInputTokens} tokens) for your current max output setting of ${effectiveMaxOutputTokens} tokens`;
  } else if (!inputText.trim()) {
    return 'Empty message, rejected';
  } else if (!currentUser) {
    return 'User data not available';
  } else if (effectiveCredits <= 0 && enforceCredits) {
    // An open-signup user whose free credits are deferred until email verification gets a clear
    // "unlock" prompt instead of a dead-end "Out of Credits!" - they've never had credits to spend.
    const awaitingVerification =
      currentUser.emailVerified === false && (currentUser.tags ?? []).includes(PENDING_FREE_CREDITS_TAG);
    return awaitingVerification
      ? 'Verify your email to unlock your free credits — check your inbox for the verification link.'
      : 'Out of Credits!';
  }
  return null;
}

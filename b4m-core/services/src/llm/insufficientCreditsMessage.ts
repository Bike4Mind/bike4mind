/**
 * Builds the plain-language, action-oriented message shown when a chat request is
 * blocked for lack of credits. Paired with `InsufficientCreditsError`'s
 * `code: 'insufficient_credits'` so the client renders an inline "Add Credits" CTA
 * (see ChatCompletionProcess catch handler + the client InsufficientCreditsNotice).
 *
 * The remedy differs by holder: a personal user can buy credits (CTA), but an org
 * member cannot self-purchase org credits, so the org copy points them at their
 * administrator instead (the client suppresses the dead-end CTA for org accounts).
 *
 * Kept as a standalone builder (mirroring buildContextOverflowMessage) so the copy is
 * unit-testable and shared across credit checks.
 */
export function buildInsufficientCreditsMessage(params: {
  /** Credits currently available to the holder (user or organization). */
  available: number;
  /** Credits this request needs. */
  required: number;
  /** Organization name when the holder is an org; omit for a personal account. */
  organizationName?: string;
}): string {
  const { available, required, organizationName } = params;
  return organizationName
    ? `Your organization "${organizationName}" is out of credits. This request needs about ${required} credits, but only ${available} are available. Contact your organization administrator to add more credits.`
    : `You're out of credits. This request needs about ${required} credits, but only ${available} are available. Add credits to keep going.`;
}

/** Why the balance is 0, in one sentence for the out-of-credits block. */
export function zeroCreditReason({
  awaitingVerification,
  personal,
}: {
  awaitingVerification: boolean;
  /** The spent balance is the user's own, not an organization's. */
  personal: boolean;
}): string {
  if (!personal) return 'Your organization has used all of its credits.';
  return awaitingVerification
    ? 'Your free credits are held until you verify your email.'
    : "You've used all of your credits.";
}

/**
 * Build the user-facing reply for a run that stopped because it hit the iteration ceiling
 * (rather than the model signaling completion).
 *
 * On that path the extracted "final answer" is whatever the model happened to be mid-sentence
 * on -- often a trailed-off intent ("...let me close the loop on the third one now") that then
 * just stops. Surfacing that verbatim reads as a broken, useless response. Instead we wrap it in
 * a deterministic, honest notice: the run was truncated, here is the partial progress, and the
 * user can continue with a follow-up. Pure + side-effect-free so it is unit-testable. See #674.
 */
export function buildTruncatedRunReply(maxIterations: number, finalAnswer?: string): string {
  const partial = finalAnswer?.trim();
  const header = `This run reached its ${maxIterations}-iteration limit before finishing, so the result below is partial.`;
  const footer = 'Send a follow-up to continue from where this left off.';
  return partial ? `${header}\n\n${partial}\n\n${footer}` : `${header}\n\n${footer}`;
}

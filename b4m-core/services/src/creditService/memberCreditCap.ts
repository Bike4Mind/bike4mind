import { getPeriodUsedCredits, IOrganizationDocument } from '@bike4mind/common';

/**
 * Per-member credit cap logic, factored out so the two reservation pre-flights
 * (web chat in ChatCompletionProcess, CLI/API in cliCompletions) share one
 * decision instead of hand-copying it.
 *
 * The cap MUST be enforced at reservation (before work begins), never at
 * settlement: by settlement the response has streamed and the balance has
 * already moved, so a throw there cannot block the request - it can only
 * sabotage the usage tracking that runs alongside it (#1536). These helpers are
 * therefore the pre-flight guard; the settlement write in
 * `deductCreditsWithOrgSupport` intentionally does NOT re-check the cap.
 */

type MemberCapOrg = Pick<IOrganizationDocument, 'userDetails' | 'maxCreditsPerMember'>;

/**
 * Internal (non-chat-facing) refusal message for an already-capped member, shared by
 * every caller that records a plain execution-failure string rather than rendering a
 * chat notice: `ServerSubagentOrchestrator`'s in-process delegation gate, the agent
 * executor's own per-member cap gates, and the CLI/API pre-flight. Deliberately
 * distinct from `buildMemberCreditCapMessage` (in `../llm/insufficientCreditsMessage`),
 * which builds the longer chat-facing CTA notice paired with `InsufficientCreditsError`
 * - swapping a caller here for that builder would change what gets persisted/asserted
 * on, not just the wording.
 */
export const MEMBER_CREDIT_CAP_MESSAGE = 'Organization member credit limit reached';

/**
 * Thrown by `ServerSubagentOrchestrator.delegateToAgent()` when the delegating
 * member is at or over their organization's per-member credit cap. A dedicated
 * class - rather than matching a plain `Error` on `.message` - so a caller that
 * needs to special-case this refusal survives a future rewrap: `isMemberCreditCapError`
 * walks the `.cause` chain, so wrapping this in another error (e.g. `new Error('...',
 * { cause: original })`) still detects it, where a string-equality check would not.
 */
export class MemberCreditCapError extends Error {
  constructor() {
    super(MEMBER_CREDIT_CAP_MESSAGE);
    this.name = 'MemberCreditCapError';
  }
}

/** True when `error` is a `MemberCreditCapError`, or wraps one via `.cause`. */
export function isMemberCreditCapError(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if (current instanceof MemberCreditCapError) return true;
    current = current.cause;
  }
  return false;
}

export { getMemberCreditPeriodEnd, getMemberCreditPeriodStart } from '@bike4mind/common';

/**
 * Credits a member has spent against the org pool in the current monthly period (0 when
 * untracked or when the row's period has rolled over; see `getPeriodUsedCredits`).
 */
export function getMemberUsedCredits(
  organization: Pick<IOrganizationDocument, 'userDetails'>,
  userId: string,
  now: Date = new Date()
): number {
  return getPeriodUsedCredits(
    organization.userDetails?.find(u => u.id === userId),
    now
  );
}

/**
 * The monthly cap that applies to `userId`: their per-member override when set,
 * otherwise the org default. null means uncapped.
 */
export function getMemberCreditCap(organization: MemberCapOrg, userId: string): number | null {
  const override = organization.userDetails?.find(u => u.id === userId)?.maxCredits;
  return override ?? organization.maxCreditsPerMember ?? null;
}

/**
 * Whether charging `credits` to `userId` would push them past their monthly cap
 * (`getMemberCreditCap`). Returns false when no cap applies. Uses the caller's
 * estimate at reservation; a request already in flight is allowed to finish and
 * settle its actuals, so a single request may nudge fractionally over the cap
 * (mirrors the org-pool reservation, which also gates on the estimate).
 */
export function isMemberCreditCapExceeded(organization: MemberCapOrg, userId: string, credits: number): boolean {
  const cap = getMemberCreditCap(organization, userId);
  if (cap == null) {
    return false;
  }
  return getMemberUsedCredits(organization, userId) + credits > cap;
}

/**
 * Whether `userId` is already at or over their monthly cap, with no charge
 * estimate. This is the gate for spend paths that bill incrementally and have no
 * single upfront cost (e.g. an agent run settling per-iteration): they can only
 * refuse to START an already-capped member. Deliberately stricter than
 * `isMemberCreditCapExceeded` - `>=` (at the cap blocks) rather than
 * `used + estimate > cap` - because there is no estimate to add. Returns false
 * when no cap applies.
 */
export function isMemberAtOrOverCap(organization: MemberCapOrg, userId: string): boolean {
  const cap = getMemberCreditCap(organization, userId);
  if (cap == null) {
    return false;
  }
  return getMemberUsedCredits(organization, userId) >= cap;
}

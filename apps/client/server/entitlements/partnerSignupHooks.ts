/**
 * Post-signup extension point for partner signup rules. An overlay contributes hooks through
 * `b4mContributions.partnerSignupHooksExport` (a module exporting `partnerSignupHooks:
 * PartnerSignupHook[]`), which scripts/generate-premium-glue.mjs aggregates into
 * server/premium-generated/premiumPartnerSignupHooks.generated.ts. applySignupDomainGrant
 * (./signupDomainGrant.ts) runs them after the core grant for a matched DB rule succeeds.
 *
 * Core stays unaware of what a hook does. Hooks MUST be idempotent: the core grant runs on every
 * path that proves email ownership, so the same user can reach the hooks more than once.
 */
import type { Logger } from '@bike4mind/observability';
import type { SeatCeilingRaiseTrigger } from '@server/organizations/notifySeatCeilingRaised';

/** The email-ownership path that triggered the signup grant. */
export type SignupGrantTrigger = SeatCeilingRaiseTrigger;

export type PartnerSignupRuleMatch = {
  id: string;
  /** Normalized verified-email domain the rule matched on. */
  domain: string;
  /** Org the rule auto-adds members to, or null. */
  organizationId: string | null;
};

export type PartnerSignupHookContext = {
  userId: string;
  rule: PartnerSignupRuleMatch;
  /** The rule's org when the user is a member of it now; null when the join was not applied (e.g. at capacity). */
  joinedOrganizationId: string | null;
  trigger: SignupGrantTrigger;
  logger: Logger;
};

export type PartnerSignupHook = {
  /** Identifies the hook in logs. */
  name: string;
  run: (context: PartnerSignupHookContext) => Promise<void>;
};

/** Per-hook budget (ms). Hooks run inside the signup request, so a stalled one must not hold it open. */
export const PARTNER_SIGNUP_HOOK_TIMEOUT_MS = 10_000;

async function runWithTimeout(hook: PartnerSignupHook, context: PartnerSignupHookContext): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${PARTNER_SIGNUP_HOOK_TIMEOUT_MS}ms`)),
      PARTNER_SIGNUP_HOOK_TIMEOUT_MS
    );
  });
  try {
    // async wrapper turns a hook that throws synchronously into a rejection instead of an escape.
    await Promise.race([(async () => hook.run(context))(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run every hook concurrently. Never throws: a failing or timed-out hook is logged with its name and
 * the others still run, so an overlay can never fail a signup or undo the core grant.
 */
export async function runPartnerSignupHooks(
  hooks: readonly PartnerSignupHook[],
  context: PartnerSignupHookContext
): Promise<void> {
  const outcomes = await Promise.allSettled(hooks.map(hook => runWithTimeout(hook, context)));
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'rejected') {
      context.logger.error(
        `Partner signup hook "${hooks[index].name}" failed for user ${context.userId} ` +
          `(rule ${context.rule.id}, ${context.trigger})`,
        outcome.reason
      );
    }
  });
}

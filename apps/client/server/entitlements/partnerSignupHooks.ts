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

export type PartnerSignupRuleMatch = {
  id: string;
  /** Normalized verified-email domain the rule matched on. */
  domain: string;
  /** Org the rule auto-adds members to, or null. Set even when the join itself was not applied. */
  organizationId: string | null;
};

export type PartnerSignupHookContext = {
  userId: string;
  rule: PartnerSignupRuleMatch;
  trigger: SeatCeilingRaiseTrigger;
  logger: Logger;
};

export type PartnerSignupHook = {
  /** Identifies the hook in logs. */
  name: string;
  run: (context: PartnerSignupHookContext) => Promise<void>;
};

/**
 * Run every hook concurrently. Never throws: a failing hook is logged with its name and the
 * others still run, so an overlay can never fail a signup or undo the core grant.
 */
export async function runPartnerSignupHooks(
  hooks: readonly PartnerSignupHook[],
  context: PartnerSignupHookContext
): Promise<void> {
  // async wrapper turns a hook that throws synchronously into a rejection instead of an escape.
  const outcomes = await Promise.allSettled(hooks.map(async hook => hook.run(context)));
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

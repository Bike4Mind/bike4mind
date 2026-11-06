/**
 * Works the Signup Domain Holds queue (/admin?tab=signup-domain-holds) for the holds that need no
 * judgment. A hold only ever keeps free credits held, so this job may confirm a hold but never
 * releases one: a release pays out credits and stays an admin action in the route
 * apps/client/pages/api/admin/signup-domain-holds.ts.
 *
 * Rule: a `disposable-aggregate` hold is confirmed when the autoConfirmDisposableAggregateHolds
 * setting is on. Each confirmation writes a strict Admin Audit Log entry attributed to the system in
 * the same transaction, and the hold's autoDecision marks the row in the admin tab.
 * Advisory assessment: after the rule, pending young-domain holds get a Decisions verdict when
 * signupDomainHoldAssessmentEnabled is on; a confident abuse verdict confirms the same way (see
 * apps/client/server/security/signupDomainHoldAssessment/signupDomainHoldAssessment.ts).
 * Schedule: rate(10 minutes) (infra/cron.ts signupDomainHoldTriage), on stages that run scheduled
 * jobs. Not on self-host yet; it ports with disposableDomainRefresh (selfhostParityPolicy.ts).
 */
import {
  DISPOSABLE_AGGREGATE_HOLD_REASON,
  type AuditActor,
  type SignupDomainHoldAutoPolicy,
  type SignupDomainReview,
} from '@bike4mind/common';
import {
  adminAuditLogRepository,
  adminSettingsRepository,
  connectDB,
  signupDomainReviewRepository,
  withTransaction,
} from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { adminAuditService } from '@bike4mind/services';
import { Config } from '@bike4mind/server-utils/utils/config';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { Resource } from 'sst';
import type { Context } from 'aws-lambda';
import {
  defaultSignupDomainHoldAssessmentDeps,
  runSignupDomainHoldAssessments,
} from '@server/security/signupDomainHoldAssessment/signupDomainHoldAssessment';

const logger = new Logger({ metadata: { service: 'signupDomainHoldTriage' } });

/** Stop starting new assessments this long before the Lambda timeout. */
const STOP_MARGIN_MS = 60_000;

/** Holds confirmed per run; a larger backlog drains over the following runs. */
export const TRIAGE_BATCH_LIMIT = 200;

const RULE_POLICY: SignupDomainHoldAutoPolicy = 'disposable-aggregate-rule';

// Same shape as systemAuditActor() in packages/server-utils/src/utils/adminAudit.ts.
const SYSTEM_ACTOR: AuditActor = {
  kind: 'system',
  scope: 'platform',
  name: 'signup-domain-hold-triage',
  wasAdmin: false,
};

export type SignupDomainHoldTriageDeps = {
  holds: Pick<typeof signupDomainReviewRepository, 'listPending' | 'autoConfirm'>;
  isRuleEnabled: () => Promise<boolean>;
  /** Runs the confirm and its audit entry atomically, so an unrecorded confirmation rolls back. */
  inTransaction: <T>(fn: () => Promise<T>) => Promise<T>;
  recordAudit: (input: adminAuditService.RecordAdminActionInput) => Promise<unknown>;
  now: () => Date;
  logger: Pick<Logger, 'info' | 'error'>;
};

export type SignupDomainHoldTriageResult =
  { status: 'disabled' } | { status: 'ran'; considered: number; confirmed: number; skipped: number; failed: number };

const confirmByRule = async (hold: SignupDomainReview, deps: SignupDomainHoldTriageDeps): Promise<boolean> => {
  const decidedAt = deps.now();
  return deps.inTransaction(async () => {
    if (!(await deps.holds.autoConfirm(hold.domain, hold.reason, RULE_POLICY, decidedAt))) return false;
    await deps.recordAudit({
      action: 'signup_domain_hold.auto_confirmed',
      actor: SYSTEM_ACTOR,
      target: { kind: 'system', id: `signup-domain-hold:${hold.domain}`, displayName: hold.domain },
      summary: `confirmed the signup domain hold on ${hold.domain} (rule: ${hold.reason})`,
      context: { source: 'worker', route: 'cron/signupDomainHoldTriage' },
      changes: [{ field: 'status', before: 'held_pending_review', after: 'blocked' }],
      details: { policy: RULE_POLICY, reason: hold.reason, signupCount: hold.signupCount },
      occurredAt: decidedAt,
    });
    return true;
  });
};

export async function runSignupDomainHoldTriage(
  deps: SignupDomainHoldTriageDeps
): Promise<SignupDomainHoldTriageResult> {
  if (!(await deps.isRuleEnabled())) return { status: 'disabled' };
  const pending = await deps.holds.listPending(DISPOSABLE_AGGREGATE_HOLD_REASON, TRIAGE_BATCH_LIMIT);
  let confirmed = 0;
  let skipped = 0;
  let failed = 0;
  for (const hold of pending) {
    try {
      if (await confirmByRule(hold, deps)) confirmed++;
      else skipped++;
    } catch (error) {
      failed++;
      deps.logger.error('[signupDomainHoldTriage] auto-confirm failed', { domain: hold.domain, error });
    }
  }
  const result = { status: 'ran' as const, considered: pending.length, confirmed, skipped, failed };
  if (pending.length) deps.logger.info('[signupDomainHoldTriage] done', result);
  return result;
}

export const handler = async (_event?: unknown, context?: Pick<Context, 'getRemainingTimeInMillis'>) => {
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage));
  const result = await runSignupDomainHoldTriage({
    holds: signupDomainReviewRepository,
    isRuleEnabled: async () => {
      // Fresh read every run so turning the setting off stops the next run, not after a cache TTL.
      const settings = await getSettingsMap(
        { adminSettings: adminSettingsRepository },
        { skipCache: true, names: ['autoConfirmDisposableAggregateHolds'] }
      );
      return getSettingsValue('autoConfirmDisposableAggregateHolds', settings, true);
    },
    inTransaction: fn => withTransaction(() => fn(), { logger }),
    recordAudit: input =>
      adminAuditService.recordAdminAction(input, { db: { adminAuditLog: adminAuditLogRepository }, logger }),
    now: () => new Date(),
    logger,
  });
  const assessment = await runSignupDomainHoldAssessments(
    defaultSignupDomainHoldAssessmentDeps(logger, () =>
      context ? context.getRemainingTimeInMillis() < STOP_MARGIN_MS : false
    )
  );
  // Surface partial failure as a Lambda error so the alarm sees it; the next run retries the rest.
  // A provider failure is a stored verdict, not an error; only unexpected errors count here.
  if (result.status === 'ran' && result.failed > 0) {
    throw new Error(`signupDomainHoldTriage: ${result.failed} of ${result.considered} holds failed`);
  }
  if (assessment.status !== 'skipped' && assessment.errors > 0) {
    throw new Error(`signupDomainHoldTriage: ${assessment.errors} of ${assessment.considered} assessments failed`);
  }
  return { ...result, assessment };
};

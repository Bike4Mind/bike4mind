import {
  CreditHolderType,
  IAdminSettingsRepository,
  ICreditHolderMethods,
  ICreditTransactionRepository,
  IOrganizationDocument,
  IOrganizationRepository,
  IUsageEventInput,
  IUsageEventRepository,
  IUserDocument,
  UsageEventFeature,
  UsagePriceStamp,
  usdToCreditsStochastic,
  type CompletionSource,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { deductCreditsWithOrgSupport } from '../creditService';
import {
  isOperationalBillingEnabled,
  areCreditsEnforced,
  type ActivePlanResolver,
  type OperationalBillingCheck,
} from './isOperationalBillingEnabled';
import { usageEventStatusForFinish } from '../llm/earlyStopStamp';

/** The non-chat AI spend this helper records: operational-model calls and query embeddings. */
export type OperationalUsageFeature = Extract<UsageEventFeature, 'operations' | 'embedding'>;

export interface RecordOperationalUsageParams {
  /** App-level correlation id: sessionId for session ops, questId/run id otherwise. */
  requestId: string;
  /** The user whose action incurred the spend (attribution + billing target). */
  user: IUserDocument;
  /** The user's organization, when they belong to one; attribution rolls up to it. */
  organization?: IOrganizationDocument | null;
  sessionId?: string;
  /** Data lake this call is 1:1 attributable to - ingestion embeds and research-run judge calls. */
  dataLakeId?: string;
  feature: OperationalUsageFeature;
  /** Provider/backend, e.g. 'openai', 'voyageai'. */
  provider: string;
  /** Exact model id used for the call. */
  model: string;
  inputTokens: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  /** Provider COGS in USD, computed by the caller with the model-appropriate pricing fn. */
  costUsd: number;
  /**
   * Rate provenance for costUsd (buildUsagePriceStamp), from a caller that priced a text model.
   * Unset for callers with no ModelInfo or token split (embeddings, run-level judge totals).
   */
  priceStamp?: UsagePriceStamp;
  latencyMs?: number;
  source?: CompletionSource;
  /** Provider stop reason of the underlying completion, e.g. `CompletionInfo.stopReason`. */
  finishReason?: string;
  /**
   * Skip the credit-deduction path entirely, regardless of the billOperationalUsage/
   * enforceCredits admin settings. For spend already governed by its own dedicated
   * budget/gate (e.g. data-lake embedding spend levers) - debiting credits on top of
   * that gate would be a second, unreviewed billing mechanism for the same spend.
   * Redundant with passing a narrowed `db` (see RecordOperationalUsageAdapters) that omits
   * creditTransactions/users/organizations, which already forces recorded-only - use this
   * flag when the caller still has the full db but wants the bypass explicit and intentional
   * rather than an incidental side effect of which repos it happened to wire up.
   */
  bypassCreditBilling?: boolean;
  /**
   * Debit credits even when the `billOperationalUsage` policy is off, as long as this deployment
   * meters credits at all (`enforceCredits`). The counterpart of `bypassCreditBilling`, for spend
   * that carries its OWN credit economics rather than the deployment's operational-billing policy:
   * a data-lake research run is charged to the lake owner on every deployment that meters credits,
   * matching the `enforceCredits`-keyed pre-flight in `startResearchRun` that refuses to start one.
   * Without this the two would disagree - the pre-flight would refuse work this settlement never
   * charged, because `billOperationalUsage` defaults off.
   *
   * `bypassCreditBilling` wins if both are set: an explicit skip is never overridden.
   */
  forceCreditBilling?: boolean;
  /**
   * Credits the caller already charged through its own reservation (e.g. a credit hold settled
   * around the provider call). Recorded as the event's `creditsCharged`; never debited again here.
   */
  settledCredits?: number;
}

/** The repos the deduct path needs, all-or-nothing; a host passes them to let operational spend debit. */
export type OperationalBillingAdapters = {
  creditTransactions: ICreditTransactionRepository;
  users: ICreditHolderMethods;
  organizations: IOrganizationRepository;
  /** Enables the free-tier carve-out (see isOperationalBillingEnabled); absent, only the toggle bills. */
  activePlans?: ActivePlanResolver;
};

export interface RecordOperationalUsageAdapters {
  db: {
    /** Optional so a host without the analytics repo degrades to a no-op rather than throwing. */
    usageEvents?: Pick<IUsageEventRepository, 'record'>;
    adminSettings: Pick<IAdminSettingsRepository, 'findAll' | 'findBySettingNames'>;
    // Billing repos are all-or-nothing: the deduct path runs only when all three are present.
    // A caller that omits them (a host that does not bill) gets recorded-only.
  } & Partial<OperationalBillingAdapters>;
  /** A request- or turn-scoped memo of the billing decision (memoizeOperationalBillingCheck). */
  billingCheck?: OperationalBillingCheck;
  logger: Logger;
}

/**
 * Route non-chat AI spend (operational-model calls, query embeddings) through the usage
 * infrastructure so it stops being invisible. Always writes a UsageEvent (analytics COGS);
 * debits credits when `isOperationalBillingEnabled` says so for this holder (credits enforced,
 * and either `billOperationalUsage` is on or the holder is free tier and `db.activePlans` is
 * wired) - or when the caller passes `forceCreditBilling`, which substitutes `enforceCredits`
 * alone for callers whose spend has its own credit economics (see that flag).
 *
 * Never throws: a billing or analytics failure here must not break the operational call it
 * is measuring. The billing (deduct) path reuses the `text_generation_usage` ledger machinery
 * for both features - the precise feature ('operations' | 'embedding') lives on the UsageEvent;
 * the ledger row (opt-in, off by default) does not distinguish embeddings from operational text.
 *
 * PER-MEMBER CAP: deliberately EXEMPT (#1651). `maxCreditsPerMember` BELONGS at the reservation
 * pre-flight of the paths that trigger this spend, never here - this helper must not throw, so a
 * cap check could only skip the debit (already what an unbilled call does), break the operational
 * call it measures, or mark the UsageEvent over-cap (observability, not enforcement). That is
 * where the cap belongs, not a claim that it is there today: see below for where it is missing.
 *
 * The bound is uneven, so do not read this as "every caller is gated upstream". The LLM-tool and
 * knowledge-base callers debit only on a host that wires `ToolContext.db.operationalBilling`, and
 * are not gated before the call. `apps/workers/src/queueHandlers/fabFileVectorize` reserves
 * through its own credit hold and passes `settledCredits`. The other debit-capable callers are
 * `apps/workers/src/events/recordSessionOperationalUsage` and
 * `pages/api/data-lakes/semantic-search`; both are gated at their entry points, not here.
 * semantic-search runs its own per-member-cap and pool pre-flight before embedding, and the
 * session-event publishers run `server/utils/sessionOperationalCreditPreflight` (#1852) - the
 * ungated `SessionEvents` publishers are `POST /api/sessions/[id]/tag`,
 * `POST /api/sessions/[id]/summary`, the project-attach fan-out
 * (`pages/api/projects/[id]/sessions.ts`) and the admin spider; the rest already sit behind gated
 * primary actions. A NEW publisher of those events inherits no gate: add the pre-flight at its
 * entry point, not in this measurement helper.
 */
export async function recordOperationalUsage(
  params: RecordOperationalUsageParams,
  adapters: RecordOperationalUsageAdapters
): Promise<void> {
  const { user, organization, feature } = params;
  const { db, logger } = adapters;
  const outputTokens = params.outputTokens ?? 0;

  let creditsCharged = params.settledCredits ?? 0;
  try {
    // A db without billing repos can only ever record, so the flags cannot change the outcome -
    // read them only where the debit path is reachable, keeping the fresh read off record-only hosts.
    const canDebit = Boolean(db.creditTransactions && db.users && db.organizations);
    const shouldBill =
      !params.bypassCreditBilling &&
      params.settledCredits === undefined &&
      canDebit &&
      (params.forceCreditBilling
        ? await areCreditsEnforced(db, logger)
        : await (adapters.billingCheck ?? (holder => isOperationalBillingEnabled(db, logger, holder)))(
            db.activePlans ? { user, organization, activePlans: db.activePlans } : undefined
          ));

    if (shouldBill && db.creditTransactions && db.users && db.organizations) {
      const credits = usdToCreditsStochastic(params.costUsd);
      // Stochastic settlement legitimately rounds a sub-credit cost to 0 (paid in
      // expectation across calls); only touch the ledger when it lands above zero.
      if (credits > 0) {
        await deductCreditsWithOrgSupport(
          {
            type: 'text_generation_usage',
            user,
            organization,
            credits,
            sessionId: params.sessionId ?? '',
            questId: params.requestId,
            model: params.model,
            inputTokens: params.inputTokens,
            outputTokens,
            source: params.source ?? 'system',
          },
          {
            db: {
              creditTransactions: db.creditTransactions,
              users: db.users,
              organizations: db.organizations,
            },
          }
        );
        creditsCharged = credits;
      }
    }
  } catch (err) {
    logger.warn(`[recordOperationalUsage] credit deduction failed for ${feature}; recording as unbilled`, err);
  }

  const event: IUsageEventInput = {
    requestId: params.requestId,
    userId: user.id,
    ownerId: organization ? organization.id : user.id,
    ownerType: organization ? CreditHolderType.Organization : CreditHolderType.User,
    sessionId: params.sessionId,
    dataLakeId: params.dataLakeId,
    feature,
    provider: params.provider,
    model: params.model,
    inputTokens: params.inputTokens,
    outputTokens,
    cachedInputTokens: params.cachedInputTokens ?? 0,
    cacheWriteTokens: params.cacheWriteTokens ?? 0,
    // Operational/embedding tokens are always local estimates (provider usage isn't
    // threaded back through these paths), so the basis is always 'local'.
    settledBasis: 'local',
    costUsd: params.costUsd,
    creditsCharged,
    ...params.priceStamp,
    // Same refund key the chat/CLI completion paths record: see usageEventStatusForFinish.
    status: usageEventStatusForFinish(params.finishReason),
    latencyMs: params.latencyMs,
    // Same origin as this call's ledger write above (params.source ?? 'system').
    source: params.source ?? 'system',
  };

  await db.usageEvents
    ?.record(event)
    .catch(err => logger.warn(`[recordOperationalUsage] usage event failed for ${feature}`, err));
}

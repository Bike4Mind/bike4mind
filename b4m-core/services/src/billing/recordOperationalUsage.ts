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
  usdToCreditsStochastic,
  type CompletionSource,
} from '@bike4mind/common';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import type { Logger } from '@bike4mind/observability';
import { deductCreditsWithOrgSupport } from '../creditService';

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
  /** Data lake this call is 1:1 attributable to (ingestion embeds only). */
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
  latencyMs?: number;
  source?: CompletionSource;
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
}

export interface RecordOperationalUsageAdapters {
  db: {
    /** Optional so a host without the analytics repo degrades to a no-op rather than throwing. */
    usageEvents?: Pick<IUsageEventRepository, 'record'>;
    adminSettings: Pick<IAdminSettingsRepository, 'findAll' | 'findBySettingNames'>;
    // Billing repos are all-or-nothing: the opt-in deduct path runs only when all three
    // are present. A caller with a narrowed db (e.g. the LLM tool context) omits them and
    // gets recorded-only regardless of the admin toggle.
    creditTransactions?: ICreditTransactionRepository;
    users?: ICreditHolderMethods;
    organizations?: IOrganizationRepository;
  };
  logger: Logger;
}

/**
 * Route non-chat AI spend (operational-model calls, query embeddings) through the usage
 * infrastructure so it stops being invisible. Always writes a UsageEvent (analytics COGS);
 * only debits credits when the admin has opted in via `billOperationalUsage` AND credits are
 * enforced. Default is recorded-only, so shipping this changes no user-facing pricing.
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
 * knowledge-base callers pass a narrowed db with no billing repos, so they can never reach the
 * deduct path at all - their safety comes from the adapter shape, not from a gated caller. The two
 * debit-capable callers are `server/events/recordSessionOperationalUsage` and
 * `pages/api/data-lakes/semantic-search`, and NEITHER is gated today: session ops are queued with
 * no pre-flight by at least `POST /api/sessions/[id]/tag`, `POST /api/sessions/[id]/summary`, the
 * project-attach fan-out (`pages/api/projects/[id]/sessions.ts`) and the admin spider (#1852;
 * other `SessionEvents` publishers do sit behind gated primary actions), and semantic-search has
 * no credit check of its own (#1843). Gating belongs at those entry points, not in a measurement
 * helper.
 */
export async function recordOperationalUsage(
  params: RecordOperationalUsageParams,
  adapters: RecordOperationalUsageAdapters
): Promise<void> {
  const { user, organization, feature } = params;
  const { db, logger } = adapters;
  const outputTokens = params.outputTokens ?? 0;

  let creditsCharged = 0;
  try {
    const settings = await getSettingsMap(db);
    // Both gates must be on to debit: billOperationalUsage opts this spend in,
    // enforceCredits is the platform-wide metering master switch (off on self-host).
    const shouldBill =
      !params.bypassCreditBilling &&
      (getSettingsValue('billOperationalUsage', settings) ?? false) &&
      (getSettingsValue('enforceCredits', settings) ?? false);

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
    status: 'ok',
    latencyMs: params.latencyMs,
    // Same origin as this call's ledger write above (params.source ?? 'system').
    source: params.source ?? 'system',
  };

  await db.usageEvents
    ?.record(event)
    .catch(err => logger.warn(`[recordOperationalUsage] usage event failed for ${feature}`, err));
}

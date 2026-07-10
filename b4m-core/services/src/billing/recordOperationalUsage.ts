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
  };

  await db.usageEvents
    ?.record(event)
    .catch(err => logger.warn(`[recordOperationalUsage] usage event failed for ${feature}`, err));
}

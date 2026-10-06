import type { Request } from 'express';
import {
  fabFileRepository,
  fabFileChunkRepository,
  apiKeyRepository,
  adminSettingsRepository,
  creditTransactionRepository,
  organizationRepository,
  usageEventRepository,
  userRepository,
  lakeAccessEventRepository,
  scopedSettingsRepository,
} from '@bike4mind/database';
import {
  apiKeyService,
  creditService,
  dataLakeService,
  isOperationalBillingEnabled,
  organizationService,
  recordOperationalUsage,
  scopedSettingsService,
} from '@bike4mind/services';
import {
  getProviderFromModel,
  resolveEmbeddingConfig,
  resolveEmbeddingWithKeylessFallback,
} from '@bike4mind/fab-pipeline';
import { selfHostOpenSearchEnabled } from '@bike4mind/db-core';
import {
  CreditHolderType,
  getEmbeddingModelCost,
  hasKeylessCloudEmbedder,
  ModelBackend,
  isSupportedEmbeddingModel,
  insufficientCreditsError,
  usdToCredits,
  type IOrganizationDocument,
  type IUserDocument,
  type LakeAccessSurface,
  type SettingScope,
  type SupportedEmbeddingModel,
} from '@bike4mind/common';
import { createTokenizer, getSettingsByNames, normalizeId, type ITokenizer } from '@bike4mind/utils';
import type { Logger } from '@bike4mind/observability';
import type { RetrievalLakeScope } from '@server/dataLakes/resolveRetrievalLakeScope';
import { resolveAuditPrincipal } from '@server/dataLakes/resolveAuditPrincipal';
import { getRequestMembershipOrgIds } from '@server/dataLakes/requestMembership';
import { BadRequestError } from '@server/utils/errors';
import { resolveApiKeyOwnerType } from '@server/utils/resolveApiKeyOwnerType';
import { resolveRequestUsageSource } from '@server/utils/resolveRequestUsageSource';

/**
 * The semantic-search core shared by POST /api/data-lakes/semantic-search (the product UI and the
 * RLM tool) and POST /api/v1/data-lakes/{id}/search (the public contract). Each route owns its
 * request validation, its access gate and its wire shape; this owns everything between an already
 * resolved lake scope and a search result: budgets, the embedding-model binding, the credit
 * pre-flight, the search itself, the lake access event and the usage settlement. Both doors
 * therefore bill, cap and audit a search identically.
 *
 * Call it AFTER the caller's lake-scope gate has run: the budget scope below reads the membership
 * memo that gate populates (see resolveBudgetScope).
 */

// Reused across requests so the tiktoken encoder is resolved once, not per search.
let sharedTokenizer: ITokenizer | undefined;
function getSharedTokenizer(logger: Logger): ITokenizer {
  if (!sharedTokenizer) sharedTokenizer = createTokenizer({ logger });
  return sharedTokenizer;
}

/** Test-only: drops the cached tokenizer so a test's `createTokenizer` mock takes effect. */
export function resetSharedTokenizerForTests(): void {
  sharedTokenizer = undefined;
}

/**
 * The scope this search resolves its budgets on (#2709).
 *
 * `scopeForCaller`'s own caveat says a consumer that needs more than the selected-org display
 * pointer "must resolve membership first and pass the result here" - so that is what this does.
 * `user.organizationId` SELECTS among the caller's orgs; `getRequestMembershipOrgIds` (#1674) is
 * what PROVES one. The access gate resolves the same memo earlier in the request (it reaches
 * `getDynamicDataLakeAccess`, which resolves membership whenever a lakes repo is wired - always,
 * here), so this reads it rather than paying for a second lookup. A pointer at an org the caller is
 * not a member of resolves to no org rung at all rather than to that org's ceiling - and, since
 * `scopeForCaller` makes the OWNER rung the ORG when one is present and the USER when it is not,
 * that caller's personal owner override governs here instead of the org's. Owner outranks
 * Organization, so it is the rung that decides.
 *
 * Budgets are read-only, so this is a tighter standard than the rung strictly needs. It is the
 * cheap one here, and it keeps the search from being the precedent that a looser derivation is fine.
 *
 * Deliberately diverges from resolveBillingOrg below (a JWT caller's org, via
 * `organizationRepository.shareable.findAccessibleById`), which also grants on a `groups[]`
 * share. A caller with only group-share access is therefore not a member here but is billed
 * against and capped by that org there, in the same request - both checks are individually
 * correct for their own purpose; see #2857 for why that disagreement is accepted as-is rather
 * than reconciled.
 */
async function resolveBudgetScope(req: Request): Promise<SettingScope> {
  const userId = req.user.id;
  const selectedOrgId = normalizeId(req.user.organizationId);
  const memberOrgIds = await getRequestMembershipOrgIds(req);
  const verifiedOrgId = selectedOrgId && memberOrgIds.includes(selectedOrgId) ? selectedOrgId : undefined;
  return scopedSettingsService.scopeForCaller({ userId, organizationId: verifiedOrgId });
}

/**
 * The organization a search bills, or null when the user pays.
 *
 * An API key carries its billing owner, so an API-key caller follows the key: the same rule
 * apiKeyAuth stamps on ApiKeyUsageLog (resolveApiKeyOwnerType) and reserveRequestCredits bills the
 * other paid API routes by. A user-billed key bills the user even when they hold an org seat. An
 * org-billed key whose organization no longer exists throws, rather than quietly billing the user.
 *
 * A browser/JWT caller bills their org seat, ACL-checked rather than the plain accessor: a stale
 * organizationId pointer (the roster no longer carries this user, #2607) must fall back to personal
 * billing rather than billing/capping against an org they've left. Same shareable ACL
 * resolveActiveOrg uses (#2769), deliberately WITHOUT its isAdmin arm - platform admin rights are
 * not a billing relationship, so an admin's own stale pointer bills personally too.
 *
 * Deliberately diverges from resolveBudgetScope above (#2709), which does not grant on a groups[]
 * share: a caller with only group-share access is billed/capped here but resolves at their personal
 * owner rung there (no org rung at all), so their own override governs instead of the org's - see
 * #2857 for why that disagreement is accepted as-is rather than reconciled.
 */
async function resolveBillingOrg(
  req: Request,
  billingUser: IUserDocument | null
): Promise<IOrganizationDocument | null> {
  if (req.apiKeyInfo) {
    if (resolveApiKeyOwnerType(req.apiKeyInfo) !== CreditHolderType.Organization) return null;
    const keyOrg = await organizationRepository.findById(req.apiKeyInfo.organizationId!);
    if (!keyOrg) throw new BadRequestError('Billing organization not found');
    return keyOrg;
  }
  return billingUser?.organizationId
    ? await organizationRepository.shareable.findAccessibleById(req.user, billingUser.organizationId)
    : null;
}

export type LakeSemanticSearchInput = {
  query: string;
  topK: number;
  minScore: number;
  tags: string[];
  /** The model to embed the query with: the caller's explicit choice, else the admin default. */
  embeddingModel: string;
  /** True when the caller NAMED `embeddingModel`; a named model is never swapped for a keyless one. */
  embeddingModelExplicit: boolean;
  scope: RetrievalLakeScope;
  /**
   * Search only lake members, dropping the caller's own and shared files that the search otherwise
   * ORs in. Set by a door scoped to one lake, whose contract promises exactly that lake's files.
   */
  restrictToDataLake?: boolean;
  /** Which door made this call, for the lake access event - see LAKE_ACCESS_SURFACES for the vocabulary. */
  surface: LakeAccessSurface;
  /** Checked between the long-running steps, so a disconnected caller stops costing work. */
  isAborted: () => boolean;
};

type SemanticSearchResult = Awaited<ReturnType<typeof dataLakeService.semanticDataLakeSearch>>;
type SearchBudgets = Awaited<ReturnType<typeof dataLakeService.resolveSearchBudgets>>;

export type LakeSemanticSearchOutcome =
  /** The scope held no lake, so nothing was embedded or billed. */
  | { kind: 'empty'; embeddingModel: string; budgets: SearchBudgets }
  /** No usable credential for the query's embedding provider. `message` names what is missing. */
  | { kind: 'provider_not_configured'; message: string }
  | { kind: 'aborted' }
  | { kind: 'ok'; search: SemanticSearchResult };

/**
 * Throws `insufficientCreditsError` (422) when the credit pre-flight rejects the caller; every other
 * refusal is a returned outcome so each route can word it for its own audience.
 */
export async function runLakeSemanticSearch(
  req: Request,
  input: LakeSemanticSearchInput
): Promise<LakeSemanticSearchOutcome> {
  const { query, topK, minScore, tags, embeddingModel, scope, isAborted, surface } = input;
  const { dataLakeTags, dataLakeTagPrefixes, lakes } = scope;

  // The pre-flight needs a token count on the request path, where the old best-effort
  // recording could just skip one; a length estimate keeps a tokenizer failure from
  // turning a working search into a 500.
  const countQueryTokens = async (model: string = embeddingModel): Promise<number> => {
    try {
      return await getSharedTokenizer(req.logger).countTokens(query, model);
    } catch (err) {
      req.logger?.warn('[semantic-search] query token count failed; estimating from query length', err);
      return Math.ceil(query.length / 4);
    }
  };

  // Both budget reads share it, so one search resolves one scope.
  const budgetScope = await resolveBudgetScope(req);

  // Every lake contributes exactly one meta-tag, so an empty tag list means zero
  // accessible lakes. Gating on the prefixes instead would be wrong: a caller can
  // legitimately hold only dynamic lakes, whose prefixes are all in the SCOPED bucket.
  if (dataLakeTags.length === 0) {
    const budgets = await dataLakeService.resolveSearchBudgets(
      { adminSettings: adminSettingsRepository, scopedSettings: scopedSettingsRepository },
      req.logger,
      budgetScope
    );
    return { kind: 'empty', embeddingModel, budgets };
  }

  // --- Billing inputs: token count, the bill/enforce pair, and the holder who would pay ---
  // Gathered here, but the pre-flight gate itself runs further down, after the query's
  // embedding model is bound - it has to price the model that will actually be embedded with.
  // Gated on the exact pair recordOperationalUsage requires to debit; a deployment that
  // never bills must not start rejecting searches.
  const queryTokens = await countQueryTokens();
  // Shared with the settlement in recordOperationalUsage, so the two cannot drift on
  // "does operational spend actually debit here".
  //
  // Deliberately NOT inside a fail-open try, unlike both the holder read below and the same
  // helper's use in sessionOperationalCreditPreflight.ts. The philosophies differ because
  // what a fallback costs differs: there, `shouldBill` gates only the pre-flight and
  // settlement re-reads the setting in the SessionEvents process, so failing open skips a
  // check and still charges. Here it gates the check AND the charge in this one request
  // (see the `shouldBill &&` guard on the settlement below), so falling back to `false`
  // would hand out an unbilled search. A throw is the safer failure for that shape.
  const shouldBill = await isOperationalBillingEnabled({ adminSettings: adminSettingsRepository }, req.logger);
  const source = resolveRequestUsageSource(req);

  // Resolved once and reused by the settlement below, so the pre-flight and the charge
  // can never disagree about which holder pays. Best-effort: a billing-store failure leaves
  // both the check and the charge undone, which is the pre-existing behaviour - it must not
  // turn a working search into a 500.
  let billingUser: IUserDocument | null = null;
  let billingOrg: IOrganizationDocument | null = null;
  try {
    // Both assigned only after both reads succeed: a half-resolved pair (user set, org
    // null) would skip the member cap and bill the member personally for org usage.
    const resolvedUser = await userRepository.findById(req.user.id);
    const resolvedOrg = await resolveBillingOrg(req, resolvedUser);
    billingUser = resolvedUser;
    billingOrg = resolvedOrg;
  } catch (billingErr) {
    // A refusal is the key's billing target, not a store failure - only the latter degrades.
    if (billingErr instanceof BadRequestError && shouldBill) throw billingErr;
    req.logger?.warn('[semantic-search] failed to resolve user/organization for billing', billingErr);
  }

  // Mint-time trust is not use-time trust: an org-billed key whose owner has since left the org
  // must not keep drawing on its pool. Same fail-closed check, and the same platform-admin arm, as
  // reserveRequestCredits.
  if (
    shouldBill &&
    req.apiKeyInfo &&
    billingOrg &&
    billingUser &&
    !billingUser.isAdmin &&
    !organizationService.isCurrentOrgMember(billingOrg, req.user.id)
  ) {
    throw new BadRequestError(
      'This API key bills an organization you are no longer a member of. Re-mint the key to continue.'
    );
  }

  // --- Get the embedding-provider API keys, for every provider we have one, not just the
  // requested model's own provider ---
  // The mixed-embeddingModel ANN cutover (semanticDataLakeSearch) can attempt an ALTERNATE
  // model from a different provider than the primary (e.g. a lake re-embedded from ada-002 to
  // voyage-3); a table scoped to only the primary model's provider means that alternate can
  // never actually be reached here, regardless of readiness/cap. Mirrors the chat
  // search_knowledge_base tool's resolveEmbeddingContext, which already resolves the full
  // multi-provider table this way.
  const userIdForService = req.user?.id || 'system';
  const requestedEmbeddingModel = embeddingModel as SupportedEmbeddingModel;
  // A cloud stage reaches Bedrock with its own role, so a missing provider key is not fatal
  // there: the vectorizer already fell back to Bedrock when it wrote this corpus, and the
  // query has to be embedded in the space the corpus actually occupies. Three carve-outs keep
  // the loud error where it is still the right answer:
  //   - self-host has no AWS role, so there is nothing to fall back TO;
  //   - a caller who NAMED the embedding model gets the error rather than a silent answer out of
  //     a different vector space than the one they asked about;
  //   - an Ollama default with no base URL. Belt-and-braces rather than load-bearing:
  //     `resolveEmbeddingWithKeylessFallback` already refuses to override `missing: 'ollama'`,
  //     and the refusal below reads that answer directly, so the crafted error naming
  //     OLLAMA_BASE_URL stands whether or not this clause is here. It stays because
  //     `mayFallBack` is also what makes `substituted` reachable, and a self-hosted Ollama
  //     default should never present as a substitution candidate in the first place.
  const mayFallBack =
    !input.embeddingModelExplicit &&
    getProviderFromModel(requestedEmbeddingModel) !== ModelBackend.Ollama &&
    hasKeylessCloudEmbedder();
  const effectiveKeys = await apiKeyService.getEffectiveLLMApiKeys(
    userIdForService,
    { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository }, getSettingsByNames },
    { logger: req.logger }
  );

  const embeddingApiKeyTable: { openai?: string | null; voyageai?: string | null; ollama?: string | null } = {
    openai: effectiveKeys?.openai,
    voyageai: effectiveKeys?.voyageai,
    ollama: effectiveKeys?.ollama,
  };

  // Bind the query's model ONCE, here: the resolved key table is the first thing that can
  // answer "is that model reachable from this deployment" (an SST secret never lands in
  // process.env, so no env read can). Everything below keys off the resolved model, so a
  // substitution is never billed or reported as the model it stood in for.
  //
  // `mayFallBack` selects the RESOLVER, rather than being applied to its answer afterwards.
  // `resolveEmbeddingWithKeylessFallback` substitutes on its own policy - any keyless cloud
  // stage - so on a request this search has already decided may not fall back, calling it and
  // then discarding the substitution still leaves `missing: null` behind, and the credential
  // gate below reads that as "ready" for a caller-named model this deployment cannot embed
  // with. The refusal is skipped and the request fails a layer down with a vaguer message, which is
  // the opposite of what naming a model is supposed to get you.
  //
  // Where a fallback IS permitted, the resolver still declines for two states it refuses to
  // read as "this deployment is keyless" - an EXPIRED caller key and `missing: 'ollama'` - so
  // `substituted` tests whether one ACTUALLY happened rather than whether it was allowed.
  const requestedProvider = getProviderFromModel(requestedEmbeddingModel);
  const resolution = mayFallBack
    ? resolveEmbeddingWithKeylessFallback(requestedEmbeddingModel, embeddingApiKeyTable)
    : { ...resolveEmbeddingConfig(requestedProvider, embeddingApiKeyTable), model: requestedEmbeddingModel };
  const substituted = resolution.missing === null && resolution.model !== requestedEmbeddingModel;
  const searchEmbeddingModel = substituted ? resolution.model : requestedEmbeddingModel;
  if (substituted) {
    req.logger?.warn(
      `[semantic-search] no credential resolved for ${requestedEmbeddingModel}; embedding the query with keyless ${searchEmbeddingModel} instead`
    );
  }

  // About the PRIMARY model only - a hard refusal here concerns the model the caller actually asked
  // for, not a downstream alternate model's coverage, which degrades gracefully via
  // semanticDataLakeSearch's own missingCredential skip reason instead. `resolution.missing` is
  // already scoped that way: it is `getProviderFromModel(requestedEmbeddingModel)`'s credential
  // and nothing else, and a keyless provider reports null because an empty config IS its ready
  // state.
  //
  // Testing `resolution.missing` rather than the raw key slot is the load-bearing part.
  // `getEffectiveLLMApiKeys` returns the literal sentinel 'expired' for a caller key that has
  // lapsed, and a seeded placeholder is a non-empty string too - both TRUTHY, so the old
  // `!effectiveKeys?.openai` form read them as a key present and skipped the crafted,
  // provider-naming error in the two cases that most needed it, leaving the request to fail a
  // layer down with a vaguer message. `usableKey` already normalizes all three to absent for
  // the resolver, so reading its answer is what keeps this gate and the embedder agreeing.
  // Same basis as the sibling route (pages/api/sessions/semantic-search.ts).
  if (!substituted) {
    if (resolution.missing === 'ollama') {
      return {
        kind: 'provider_not_configured',
        message: `Ollama base URL not configured. Required for query embedding with model ${embeddingModel}.`,
      };
    } else if (resolution.missing !== null) {
      return {
        kind: 'provider_not_configured',
        message: `${requestedProvider} API key not configured. Required for query embedding with model ${embeddingModel}.`,
      };
    }
  }

  const embeddingProvider = getProviderFromModel(searchEmbeddingModel);
  // Counted under the model that will actually run, and reused by the settlement below so the
  // pre-flight and the charge can never disagree about the token basis either.
  const searchQueryTokens =
    searchEmbeddingModel === embeddingModel ? queryTokens : await countQueryTokens(searchEmbeddingModel);

  // --- Credit pre-flight: per-member cap, then the pool the charge would land on ---
  // Runs AFTER the model is bound, and prices the model that will actually be embedded with.
  // Pricing the requested one instead leaves a hole rather than a conservative margin: Titan is
  // only cheaper than SOME of what it stands in for (it ties text-embedding-3-small and
  // voyage-3-lite), and voyage-finance-3 / voyage-law-3 are offered in the admin dropdown with
  // no entry in the price table at all - so a request under one of those priced at $0, skipped
  // the gate entirely, and then settled at Titan's real rate.
  //
  // Gate on the USD cost, not on usdToCredits' 1-credit floor: a zero-cost embedder
  // (Ollama runs on the operator's own hardware) and any model missing from the price
  // table both settle 0 credits, so there is nothing to be eligible for - flooring first
  // would turn a free search into a 422. See the pricing-table contract in
  // b4m-core/common/src/schemas/embedding.ts.
  const embeddingCostUsd = getEmbeddingModelCost(searchEmbeddingModel, searchQueryTokens);

  if (shouldBill && billingUser && embeddingCostUsd > 0) {
    // Deterministic round-up, never the stochastic settlement rounding: eligibility must
    // not turn on a coin flip. Scoped to the primary model only: the mixed-embeddingModel
    // ANN cutover can also embed up to MAX_ALTERNATE_ANN_MODELS alternates, which are not
    // known until the search runs, so settlement below can exceed this by a few credits on
    // a mixed-embedding-space corpus.
    const requiredCredits = usdToCredits(embeddingCostUsd);

    // Cap before pool, mirroring deductCreditsWithOrgSupport: a capped member must be
    // rejected even when the org pool is flush.
    if (billingOrg && creditService.isMemberCreditCapExceeded(billingOrg, req.user.id, requiredCredits)) {
      throw insufficientCreditsError(
        'Your organization member credit limit has been reached for semantic search. Contact your organization administrator.'
      );
    }

    const availableCredits = (billingOrg ?? billingUser).currentCredits ?? 0;
    if (availableCredits < requiredCredits) {
      throw insufficientCreditsError(
        billingOrg
          ? `Your organization does not have enough credits for semantic search. It currently has ${availableCredits} credits and this requires approximately ${requiredCredits}.`
          : `You do not have enough credits for semantic search. You currently have ${availableCredits} credits and this requires approximately ${requiredCredits}.`
      );
    }
  }

  if (isAborted()) return { kind: 'aborted' };

  // --- Delegate to the shared in-process semantic search service ---
  // (Same implementation AND the same lake-scope resolution the chat search_knowledge_base
  // tool uses: embed query -> scope files -> bulk chunk vectors -> cosine rank -> top-K.)
  const lakeMemberships = dataLakeService.lakeMembershipsFrom(lakes); // dynamic-lake arms, each anchored to that lake's creator
  dataLakeService.warnIfManyLakeMemberships(lakeMemberships, req.logger, 'semantic-search');
  const search = await dataLakeService.semanticDataLakeSearch(
    {
      userId: req.user.id,
      userGroups: req.user.groups ?? [],
      query,
      tags,
      topK,
      minScore,
      embeddingModel: searchEmbeddingModel,
      apiKeyTable: embeddingApiKeyTable,
      dataLakeTags,
      dataLakeTagPrefixes,
      lakeMemberships,
      ...(input.restrictToDataLake ? { restrictToDataLake: true } : {}),
      budgets: await dataLakeService.resolveSearchBudgets(
        { adminSettings: adminSettingsRepository, scopedSettings: scopedSettingsRepository },
        req.logger,
        budgetScope
      ),
      vectorSearchEnabled: (await adminSettingsRepository.getSettingsValue('EnableDataLakeVectorSearch')) ?? false,
      // Per-lake supersession collapse - `lakes` is only ever an attribution source here, never
      // a second way to resolve access (the scope is still the tags above).
      lakes,
      supersessionCollapseEnabled:
        (await adminSettingsRepository.getSettingsValue('EnableRetrievalSupersessionCollapse')) ?? false,
      logger: req.logger,
    },
    {
      db: { fabfiles: fabFileRepository, fabfilechunks: fabFileChunkRepository },
      vectorIndex: selfHostOpenSearchEnabled() ? dataLakeService.openSearchChunkAdapter : undefined,
    }
  );

  // Unless `restrictToDataLake` is set, semanticDataLakeSearch's file search is a MIXED corpus
  // (includeShared: true - collectScopedFiles ORs the caller's own/shared files in alongside the
  // lake arms), so a hit with no recoverable tag may be the caller's own private file - this must
  // NOT fall back to the full scope, and is skipped entirely when nothing returned is actually
  // attributable to a lake (not merely when nothing was returned at all).
  // Awaited (never rethrows - see recordLakeAccessEvent's doc comment): a per-request
  // serverless route must not race a post-response freeze of the execution environment.
  // Recorded here, right as the search results come back - NOT after the later isAborted()
  // check - because the read already happened at this point regardless of whether the client
  // is still there for the response.
  const resolvedLakeIds = dataLakeService.attributeAccessedLakeIds(
    search.results.map(r => r.fileTags),
    lakes,
    { allowFullScopeFallback: false }
  );
  if (resolvedLakeIds.length > 0) {
    await dataLakeService.recordLakeAccessEvent(
      lakeAccessEventRepository,
      {
        ...resolveAuditPrincipal(req.user, req.apiKeyInfo),
        organizationId: normalizeId(req.user.organizationId),
        resolvedLakeIds,
        chunkIds: search.results.map(r => r.chunkId),
        scores: search.results.map(r => r.score),
        fileIds: [...new Set(search.results.map(r => r.fileId))],
        surface,
        queryText: query,
      },
      req.logger,
      adminSettingsRepository
    );
  }

  // Record the query-embedding spend for the primary model plus every alternate model the
  // mixed-embeddingModel ANN cutover actually embedded under - each alternate embed ran (and
  // is billable) regardless of whether its ANN query then found anything. `user`/`organization`
  // are the same documents the credit pre-flight above read, so the check and the charge can
  // never disagree about which holder pays (they can differ on amount - the pre-flight prices
  // the primary model only), and every recording runs concurrently.
  // Best-effort as a whole: a recording failure must never fail the search response, and one
  // model's recording failure must never skip another's.
  try {
    if (billingUser) {
      const recordEmbeddingUsage = async (model: string, provider: string): Promise<void> => {
        try {
          const tokens = model === searchEmbeddingModel ? searchQueryTokens : await countQueryTokens(model);
          await recordOperationalUsage(
            {
              requestId: req.user.id,
              user: billingUser,
              organization: billingOrg,
              feature: 'embedding',
              provider,
              model,
              inputTokens: tokens,
              costUsd: getEmbeddingModelCost(model, tokens),
              source,
            },
            {
              db: {
                usageEvents: usageEventRepository,
                adminSettings: adminSettingsRepository,
                creditTransactions: creditTransactionRepository,
                users: userRepository,
                organizations: organizationRepository,
              },
              logger: req.logger,
            }
          );
        } catch (recordErr) {
          req.logger?.warn(`[semantic-search] failed to record embedding usage for ${model}`, recordErr);
        }
      };

      await Promise.all([
        recordEmbeddingUsage(searchEmbeddingModel, embeddingProvider),
        // Defensive: the planner (alternateModelAnn.ts) already only ever selects a
        // registry-known model, so this filter should never actually drop anything. Mirrors
        // the same guard in knowledgeBaseSearch/index.ts's recordAllEmbeddingUsage.
        ...search.alternateModelsEmbedded
          .filter(isSupportedEmbeddingModel)
          .map(altModel => recordEmbeddingUsage(altModel, getProviderFromModel(altModel))),
      ]);
    }
  } catch (recordErr) {
    req.logger?.warn('[semantic-search] embedding usage recording failed', recordErr);
  }

  if (isAborted()) return { kind: 'aborted' };

  return { kind: 'ok', search };
}

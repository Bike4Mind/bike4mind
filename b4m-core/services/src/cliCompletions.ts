import {
  ChatModels,
  IMessage,
  CompletionInfo,
  getTextModelCost,
  CreditHolderType,
  ICreditHolder,
  ICreditHolderMethods,
  IAdminSettingsRepository,
  IApiKeyRepository,
  ICreditTransactionRepository,
  IOrganizationDocument,
  IOrganizationRepository,
  IUsageEventRepository,
  IUserApiKeyRepository,
  IUserRepository,
  type CompletionSource,
} from '@bike4mind/common';
import {
  usdToCredits,
  usdToCreditsStochastic,
  getSettingsMap,
  getSettingsValue,
  getSettingsByNames,
} from '@bike4mind/utils';
import {
  getLlmByModel,
  getAvailableModels,
  type ICompletionOptions,
  type ICompletionOptionTools,
  type ApiKeyTable,
} from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import { getEffectiveLLMApiKeys } from './apiKeyService';
import { subtractCredits } from './creditService';
import { InsufficientCreditsError } from './llm/ChatCompletionProcess';

export interface CompletionParams {
  userId: string;
  model: string;
  messages: IMessage[];
  options?: {
    temperature?: number;
    maxTokens?: number;
    stream?: boolean;
    /**
     * Tools as sent over the wire. Matches the CompletionTool wire schema
     * (no `toolFn`). The CLI endpoint runs with executeTools: false, so
     * toolFn is never invoked server-side.
     */
    tools?: import('@bike4mind/common').CompletionTool[];
    /**
     * Structured-output contract. See ResponseFormat in
     * b4m-core/common/src/schemas/cliCompletions.ts.
     */
    response_format?: import('@bike4mind/common').ResponseFormat;
  };
  /**
   * Database repositories required for completion execution
   * ALL repositories are required for proper credit tracking and settings
   */
  db: {
    adminSettings: IAdminSettingsRepository;
    apiKeys: IApiKeyRepository;
    creditTransactions: ICreditTransactionRepository;
    users: IUserRepository;
    usageEvents?: IUsageEventRepository;
    /** Required only when `billingOrganizationId` is set (org-billed API keys). */
    organizations?: IOrganizationRepository;
    /**
     * Wire only for API-key-authenticated paths that meter per-key spend (the
     * embed route). When present with `apiKeyInfo.keyId`, settled credits are
     * accumulated on the key via incrementSpend for spend-cap enforcement.
     */
    userApiKeys?: IUserApiKeyRepository;
  };
  /**
   * API key information if authenticated via API key
   * Used for credit transaction tracking and audit logging
   */
  apiKeyInfo?: {
    keyId: string;
    keyName: string;
  };
  /**
   * When set, this completion's credits are reserved from and settled to the
   * organization's shared pool (`ownerType: Organization`) instead of the
   * requesting user. The user in `userId` stays the actor for attribution and
   * per-member usage tracking. Set by the auth layer for org-billed API keys.
   * Requires `db.organizations`.
   */
  billingOrganizationId?: string;
  /** Correlation id for the usage-event dual write. Synthesized when absent. */
  requestId?: string;
  /**
   * Where this completion request originated. Recorded on the credit
   * transaction (and analytics event) so reports can break down usage by
   * surface (cli, api, etc.). Defaults to 'api' since this service is only
   * called by the public completions endpoints - never by web chat.
   */
  source?: CompletionSource;
  /**
   * Record the analytics usage event even when settlement did not (enforceCredits
   * off, or a settlement miss). The credit ledger/settlement itself stays gated by
   * `enforceCredits` - nothing is ever charged or double-recorded. Used by the embed
   * path, which must meter org usage regardless of the platform-wide toggle. Off by
   * default, so existing callers record only on the settlement-success path as before.
   */
  alwaysRecordUsage?: boolean;
  logger?: Logger;
  onChunk: (text: (string | null | undefined)[], info?: CompletionInfo) => Promise<void>;
}

/**
 * Estimate input tokens from messages. Conservative pre-flight estimate at
 * 2.5 chars/token (code, JSON, and non-English tokenize less efficiently).
 */
function estimateInputTokens(messages: IMessage[]): number {
  const totalChars = messages.reduce((sum, msg) => {
    const contentLength = typeof msg.content === 'string' ? msg.content.length : JSON.stringify(msg.content).length;
    return sum + contentLength;
  }, 0);
  return Math.ceil(totalChars / 2.5);
}

/**
 * Shared LLM completion logic
 * Used by Next.js API route, Lambda function, and available for 3rd party integrations
 */
export async function executeCompletion(params: CompletionParams): Promise<void> {
  const { userId, model, messages, options, db, logger, onChunk, apiKeyInfo } = params;
  const source: CompletionSource = params.source ?? 'api';
  const completionStartTime = Date.now();

  // Resolve the credit holder. Org-billed API keys reserve from and settle to the
  // organization's shared pool; everything else bills the requesting user. The user
  // stays the actor (attribution + per-member usage), only the pool differs.
  let organization: IOrganizationDocument | null = null;
  if (params.billingOrganizationId) {
    if (!db.organizations) {
      throw new Error('[CLI_CREDITS] organizations repository is required to bill an organization API key');
    }
    organization = await db.organizations.findById(params.billingOrganizationId);
    if (!organization) {
      throw new Error(`[CLI_CREDITS] Billing organization ${params.billingOrganizationId} not found`);
    }
  }
  const billToOrg = organization !== null;
  const holderId = billToOrg ? organization!.id : userId;
  const holderType = billToOrg ? CreditHolderType.Organization : CreditHolderType.User;
  const holderMethods: ICreditHolderMethods = billToOrg ? db.organizations! : db.users;
  const fetchHolder = (): Promise<ICreditHolder | null> =>
    billToOrg ? db.organizations!.findById(holderId) : db.users.findById(holderId);

  // Get effective API keys (user keys or fallback to admin demo keys)
  const apiKeys = await getEffectiveLLMApiKeys(userId, { db, getSettingsByNames });

  const models = await getAvailableModels(apiKeys);
  const modelInfo = models.find(m => m.id === (model as ChatModels));

  const llm = getLlmByModel(apiKeys as ApiKeyTable, {
    modelInfo,
    logger: logger ?? new Logger(),
    endUserId: userId,
  });

  if (!llm) {
    throw new Error(`Failed to create LLM backend for model: ${model}`);
  }

  llm.currentModel = model;

  // Default-on with env-var kill switch. Set B4M_FEATURE_RESPONSE_FORMAT=false
  // to disable in an emergency without a redeploy.
  const responseFormatEnabled = (process.env.B4M_FEATURE_RESPONSE_FORMAT ?? 'true') === 'true';

  const maxTokens = options?.maxTokens ?? 4096;
  // Promote wire tools to ICompletionOptionTools by stamping a no-op toolFn.
  // executeTools: false means the backend never calls toolFn - it only reads
  // toolSchema. The placeholder satisfies the type contract without changing
  // behavior. Cast: wire schema's parameters use Record<string, any> while
  // ICompletionOptionTools requires a stricter property shape - the backend's
  // formatTools() coerces both shapes correctly.
  const noopToolFn: ICompletionOptionTools['toolFn'] = async () => '';
  const promotedTools: ICompletionOptionTools[] | undefined = options?.tools?.map(t => ({
    ...t,
    toolFn: (t as { toolFn?: ICompletionOptionTools['toolFn'] }).toolFn ?? noopToolFn,
  })) as ICompletionOptionTools[] | undefined;

  const completionOptions: Partial<ICompletionOptions> = {
    temperature: options?.temperature,
    maxTokens,
    stream: options?.stream ?? true,
    tools: promotedTools ?? [],
    executeTools: false, // CLI executes tools locally, not server
    ...(responseFormatEnabled && options?.response_format ? { responseFormat: options.response_format } : {}),
  };

  if (options?.response_format) {
    logger?.info?.(
      `[CLI_COMPLETIONS] response_format gate: enabled=${responseFormatEnabled}, type=${options.response_format.type}, hasTools=${(options?.tools?.length ?? 0) > 0}`
    );
  }

  // Credit enforcement: Fail-fast if model info is missing
  const settings = await getSettingsMap(db);
  const enforceCredits = getSettingsValue('enforceCredits', settings);

  if (enforceCredits) {
    if (!modelInfo) {
      throw new Error(
        `[CLI_CREDITS] Configuration error: Model info not found for "${model}". Cannot calculate credit cost.`
      );
    }
  }

  // Atomic credit reservation: Reserve estimated credits BEFORE execution
  // This prevents race conditions where concurrent requests pass the check
  let reservedCredits = 0;

  if (enforceCredits && modelInfo) {
    // Estimate cost based on input message length + maxTokens for output
    const estimatedInputTokens = estimateInputTokens(messages);
    const estimatedUsdCost = getTextModelCost(modelInfo, estimatedInputTokens, maxTokens);
    reservedCredits = usdToCredits(estimatedUsdCost);

    logger?.debug?.(`[CLI_CREDITS] Reserving ${reservedCredits} credits (estimated) before execution`);

    // Org-billed keys: enforce the per-member cap before touching the shared pool,
    // mirroring deductCreditsWithOrgSupport. Uses the estimate; settlement records
    // the actual usage against the member below.
    if (billToOrg && organization!.maxCreditsPerMember != null) {
      const member = organization!.userDetails?.find(u => u.id === userId);
      const usedCredits = member?.usedCredits ?? 0;
      if (usedCredits + reservedCredits > organization!.maxCreditsPerMember) {
        throw new InsufficientCreditsError('Organization member credit limit reached', 'insufficient_credits');
      }
    }

    // Atomically reserve credits using incrementCredits with negative value
    const holderAfterReservation = await holderMethods.incrementCredits(holderId, -reservedCredits);

    if (!holderAfterReservation || holderAfterReservation.currentCredits < 0) {
      // Rollback the reservation immediately
      await holderMethods.incrementCredits(holderId, reservedCredits);
      const actualBalance = (holderAfterReservation?.currentCredits ?? 0) + reservedCredits;
      throw new InsufficientCreditsError(
        billToOrg
          ? `Your organization does not have enough credits. It has ${actualBalance} credits, but this request requires approximately ${reservedCredits}. Please contact your organization administrator to add more credits.`
          : `Insufficient credits. You have ${actualBalance} credits, but this request requires approximately ${reservedCredits} credits. ` +
              `Try using a smaller model or reducing the prompt size.`,
        'insufficient_credits'
      );
    }

    logger?.debug?.(
      `[CLI_CREDITS] Credits reserved successfully. Balance after reservation: ${holderAfterReservation.currentCredits}`
    );
  }

  // Track tokens across callback invocations for credit calculation.
  //
  // CONTRACT: assign-not-add. Backends emit running totals (cumulative across
  // all recursive tool turns), not per-turn deltas. Each backend threads an
  // accumulator through `_internal` and emits `accum + thisTurn` on the
  // terminal cb of every turn so the final cb carries the full multi-turn
  // sum. If you change `=` to `+=` here, every multi-turn call will silently
  // double-count. See the accumulator pattern in
  // {anthropic,openai,xai,gemini,bedrock}Backend.ts.
  let finalInputTokens = 0;
  let finalOutputTokens = 0;
  // Cache token deltas (Anthropic & Bedrock today, expandable to others).
  // Same assign-not-add contract as input/output tokens.
  let finalCacheReadTokens = 0;
  let finalCacheCreationTokens = 0;

  const wrappedOnChunk = async (text: (string | null | undefined)[], info?: CompletionInfo) => {
    if (info?.inputTokens) finalInputTokens = info.inputTokens;
    if (info?.outputTokens) finalOutputTokens = info.outputTokens;
    if (info?.cacheReadInputTokens) finalCacheReadTokens = info.cacheReadInputTokens;
    if (info?.cacheCreationInputTokens) finalCacheCreationTokens = info.cacheCreationInputTokens;

    if (info?.inputTokens || info?.outputTokens) {
      logger?.debug?.(
        `[CLI_CREDITS] Stream callback with usage: ${info.inputTokens || 0} input + ${info.outputTokens || 0} output tokens` +
          (info?.cacheReadInputTokens || info?.cacheCreationInputTokens
            ? ` (+${info.cacheReadInputTokens || 0} cache read, +${info.cacheCreationInputTokens || 0} cache write)`
            : '')
      );
    }

    // Calculate credit usage for display purposes (always, regardless of enforcement)
    // Calculate even when tokens are 0 (some models have minimum charges)
    if (modelInfo && (info?.inputTokens || info?.outputTokens)) {
      const currentInputTokens = info.inputTokens || 0;
      const currentOutputTokens = info.outputTokens || 0;
      const currentCacheReadTokens = info.cacheReadInputTokens || 0;
      const currentCacheCreationTokens = info.cacheCreationInputTokens || 0;
      const currentUsdCost = getTextModelCost(
        modelInfo,
        currentInputTokens,
        currentOutputTokens,
        currentCacheReadTokens,
        currentCacheCreationTokens
      );
      const currentCredits = usdToCredits(currentUsdCost);

      logger?.debug?.(
        `[CLI_CREDITS] Calculated ${currentCredits} credits during streaming ($${currentUsdCost.toFixed(6)} USD)`
      );

      // Pass credit info to client via CompletionInfo
      await onChunk(text, {
        ...info,
        creditsUsed: currentCredits,
        usdCost: currentUsdCost,
      });
    } else {
      await onChunk(text, info);
    }
  };

  try {
    await llm.complete(model, messages, completionOptions, wrappedOnChunk);
  } catch (error) {
    // If completion fails, refund the reserved credits to whichever pool paid
    if (reservedCredits > 0) {
      logger?.info?.(`[CLI_CREDITS] Completion failed, refunding ${reservedCredits} reserved credits`);
      await holderMethods.incrementCredits(holderId, reservedCredits);
    }
    throw error;
  }

  // Send final credit info to client so it shows the accurate final count.
  logger?.info?.(
    `[CLI_CREDITS] Completion finished. modelInfo exists: ${!!modelInfo}, finalInputTokens: ${finalInputTokens}, finalOutputTokens: ${finalOutputTokens}`
  );

  // Final settlement: one stochastic draw, shared by the client-facing final
  // event and the ledger adjustment below so display always equals charge.
  let finalUsdCost = 0;
  let finalCredits = 0;

  if (modelInfo) {
    finalUsdCost = getTextModelCost(
      modelInfo,
      finalInputTokens,
      finalOutputTokens,
      finalCacheReadTokens,
      finalCacheCreationTokens
    );
    finalCredits = usdToCreditsStochastic(finalUsdCost);

    logger?.info?.(
      `[CLI_CREDITS] Sending final credits to client: ${finalCredits} credits (${finalInputTokens} input + ${finalOutputTokens} output tokens` +
        (finalCacheReadTokens || finalCacheCreationTokens
          ? ` + ${finalCacheReadTokens} cache read + ${finalCacheCreationTokens} cache write`
          : '') +
        `, $${finalUsdCost.toFixed(6)} USD)`
    );

    // Send empty text with final credit info
    await onChunk([], {
      inputTokens: finalInputTokens,
      outputTokens: finalOutputTokens,
      cacheReadInputTokens: finalCacheReadTokens || undefined,
      cacheCreationInputTokens: finalCacheCreationTokens || undefined,
      creditsUsed: finalCredits,
      usdCost: finalUsdCost,
    });
  } else {
    logger?.warn?.('[CLI_CREDITS] Cannot send credits - modelInfo is undefined');
  }

  // Analytics/metering usage event. Recorded exactly once: on the settlement-success
  // path for enforced runs (preserving legacy behavior - no event when settlement is
  // skipped or fails), and via the unconditional embed fallback below when settlement
  // didn't record it. `usageRecorded` guards against a double write.
  let usageRecorded = false;
  const recordUsageEvent = (creditsCharged: number) => {
    db.usageEvents
      ?.record({
        requestId: params.requestId ?? `completion-${apiKeyInfo?.keyId ?? userId}-${Date.now()}`,
        userId,
        ownerId: holderId,
        ownerType: holderType,
        feature: 'completion_api',
        provider: modelInfo!.backend,
        model,
        inputTokens: finalInputTokens,
        outputTokens: finalOutputTokens,
        cachedInputTokens: finalCacheReadTokens,
        cacheWriteTokens: finalCacheCreationTokens,
        costUsd: finalUsdCost,
        creditsCharged,
        status: 'ok',
        latencyMs: Date.now() - completionStartTime,
      })
      .catch(err => logger?.warn?.('Failed to record usage event', err));
    usageRecorded = true;
  };

  // Adjust credits after completion: refund over-reservation or charge under-reservation
  if (enforceCredits && modelInfo) {
    try {
      // Reuse the settlement values computed above - recomputing would draw a
      // second stochastic rounding and desync the charge from what the client saw.
      const usdCost = finalUsdCost;
      const actualCredits = finalCredits;
      const creditDifference = reservedCredits - actualCredits;

      logger?.info?.(
        `[CLI_CREDITS] Actual usage: ${actualCredits} credits for ${finalInputTokens} input + ${finalOutputTokens} output tokens. ` +
          `Reserved: ${reservedCredits}, Difference: ${creditDifference}`
      );

      // Track the final holder (user or org) state for the transaction record
      let holderAfterAdjustment: ICreditHolder | null = null;

      // Adjust the difference between reserved and actual against the paying pool
      if (creditDifference !== 0) {
        // Pre-check: warn if adjustment will cause negative balance (under-reservation case)
        if (creditDifference < 0) {
          // Under-reservation: we need to charge more credits
          // Check if this will cause negative balance
          const currentHolder = await fetchHolder();
          const currentBalance = currentHolder?.currentCredits ?? 0;
          const projectedBalance = currentBalance + creditDifference;

          if (projectedBalance < 0) {
            logger?.warn?.(
              '[CLI_CREDITS] WARNING: Adjustment will cause negative balance - tracking for reconciliation',
              {
                userId,
                holderId,
                holderType,
                currentBalance,
                adjustment: creditDifference,
                projectedBalance,
                reserved: reservedCredits,
                actual: actualCredits,
              }
            );
            // Proceed with adjustment but track the shortfall in transaction metadata
          }
        }

        holderAfterAdjustment = await holderMethods.incrementCredits(holderId, creditDifference);
        logger?.debug?.(
          `[CLI_CREDITS] Credit adjustment applied: ${creditDifference > 0 ? 'refunded' : 'charged'} ${Math.abs(creditDifference)} credits. ` +
            `New balance: ${holderAfterAdjustment?.currentCredits}`
        );

        // Check for negative balance (should be rare with atomic reservation)
        if (holderAfterAdjustment && holderAfterAdjustment.currentCredits < 0) {
          logger?.error?.('[CLI_CREDITS] ALERT: Credit holder went into negative balance after adjustment', {
            userId,
            holderId,
            holderType,
            balance: holderAfterAdjustment.currentCredits,
            reserved: reservedCredits,
            actual: actualCredits,
          });
        }
      } else {
        // No adjustment needed, fetch current state for transaction record
        holderAfterAdjustment = await fetchHolder();
      }

      // Create transaction record with ACTUAL usage (not estimated/reserved)
      // Skip balance update since we already adjusted atomically above
      if (holderAfterAdjustment) {
        // Org-billed keys: record the actual charge against the acting member so
        // per-member usage + maxCreditsPerMember stay accurate (matches
        // deductCreditsWithOrgSupport). Balance already moved on the org above.
        // Kept inside this guard so per-member tracking and the ledger row commit
        // together: a null holder fetch skips both, never advancing usedCredits
        // without a matching transaction.
        if (billToOrg) {
          await db.organizations!.updateUserDetails(holderId, userId, {
            creditsDelta: actualCredits,
            lastCreditUsedAt: new Date(),
          });
        }

        Logger.globalInstance.debug('Credit usage:', actualCredits);
        // Use completion_api_usage for ALL /api/ai/v1/completions requests
        // Differentiate by endpoint, not by auth method
        const description = apiKeyInfo
          ? `API key (${apiKeyInfo.keyName}) completion usage${billToOrg ? ' (org-billed)' : ''}`
          : 'Completion API usage';

        await subtractCredits(
          {
            type: 'completion_api_usage',
            ownerId: holderId,
            ownerType: holderType,
            credits: actualCredits,
            description,
            model: model as ChatModels,
            apiKeyId: apiKeyInfo?.keyId, // Optional - present for API key auth, undefined for JWT
            inputTokens: finalInputTokens,
            outputTokens: finalOutputTokens,
            source,
            metadata: {
              // Include API key info if present
              ...(apiKeyInfo && {
                apiKeyName: apiKeyInfo.keyName,
              }),
              authMethod: apiKeyInfo ? 'api_key' : 'jwt',
              // For org-billed keys, keep the acting user for attribution even
              // though the credits leave the org pool.
              ...(billToOrg && { billedTo: 'organization', actingUserId: userId }),
              usdCost,
              reservedCredits,
              creditDifference,
            },
          },
          {
            db: { creditTransactions: db.creditTransactions },
            creditHolderMethods: holderMethods,
            skipBalanceUpdate: true,
            currentCreditHolder: holderAfterAdjustment,
          }
        );

        // Usage event on the settlement-success path (legacy behavior: an enforced
        // run records an event only when the ledger row committed).
        recordUsageEvent(actualCredits);
      }
    } catch (error) {
      // Log with sufficient detail for manual reconciliation
      logger?.error?.('[CLI_CREDITS] CRITICAL: Failed to adjust credits - requires manual reconciliation', {
        userId,
        model,
        inputTokens: finalInputTokens,
        outputTokens: finalOutputTokens,
        reservedCredits,
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw - completion already happened, but ensure this is tracked
    }
  }

  // Embed metering fallback: the embed path must record org usage even when the
  // settlement block above did not (enforceCredits off - the normal embed case - or
  // the rare enforced run whose settlement threw before recording). Guarded by
  // `usageRecorded` so an enforced run that already recorded on success never
  // double-writes. creditsCharged is 0 when enforcement is off (no charge occurred);
  // in the enforced-but-settlement-missed case it records finalCredits, and a
  // `[CLI_CREDITS] CRITICAL` reconciliation alert has already fired for that path.
  // Only the embed path opts in (alwaysRecordUsage) - legacy callers are untouched.
  if (modelInfo && params.alwaysRecordUsage && !usageRecorded) {
    recordUsageEvent(enforceCredits ? finalCredits : 0);
  }

  // A model missing from the catalog computes no cost, so per-key spend cannot
  // accumulate and a spend cap cannot trip - same blind spot as metering. Warn so
  // a mis-configured embed agent does not silently escape its cap.
  if (!modelInfo && params.alwaysRecordUsage && apiKeyInfo?.keyId) {
    logger?.warn?.('[CLI_CREDITS] Model missing from catalog - per-key spend not metered', {
      keyId: apiKeyInfo.keyId,
      model,
    });
  }

  // Per-key cumulative spend for spend-cap enforcement. Increments by the SAME
  // stochastic settlement value as the ledger adjustment and UsageEvent above, so
  // the per-key total reconciles with what was charged. Deliberately independent
  // of enforceCredits: the cap must trip on real usage cost even when the platform
  // toggle is off (the normal embed case). Fail-open: the completion already
  // streamed, so a lost increment (slight under-count) beats breaking the response.
  if (modelInfo && apiKeyInfo?.keyId && db.userApiKeys && finalCredits > 0) {
    try {
      await db.userApiKeys.incrementSpend(apiKeyInfo.keyId, finalCredits);
    } catch (err) {
      logger?.warn?.('[CLI_CREDITS] Failed to increment per-key spend', { keyId: apiKeyInfo.keyId, err });
    }
  }
}

import {
  CreditHolderType,
  ICreditHolder,
  ICreditHolderMethods,
  ICreditTransactionRepository,
  IOrganizationDocument,
  IOrganizationRepository,
  IUserDocument,
  type CompletionSource,
} from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import { subtractCredits, SubtractCreditsParameters } from './subtractCredits';

/**
 * Base parameters for credit deduction with organization support, shared by
 * every deduction type. Quest-scoped types add a `questId` (see
 * DeductCreditsWithOrgSupportParams); quest-less types (e.g. sound effects)
 * use this base directly.
 */
export interface DeductCreditsCommonParams {
  /** The user performing the action */
  user: IUserDocument;
  /** The organization (if any) to deduct credits from */
  organization: IOrganizationDocument | null | undefined;
  /** Number of credits to deduct */
  credits: number;
  /** Session ID for tracking */
  sessionId: string;
  /** Model used for the operation */
  model: string;
  /**
   * Where this deduction originated. Recorded on the credit transaction so
   * reports can break down usage by surface. Defaults to 'web' since this
   * helper is invoked from web/agent chat-completion paths (image/video/text).
   */
  source?: CompletionSource;
}

/**
 * Base parameters for quest-scoped credit deductions (image/video/text).
 */
export interface DeductCreditsWithOrgSupportParams extends DeductCreditsCommonParams {
  /** Quest ID for tracking */
  questId: string;
}

/**
 * Parameters for image generation credit deduction
 */
export interface DeductImageGenerationCreditsParams extends DeductCreditsWithOrgSupportParams {
  type: 'image_generation_usage';
}

/**
 * Parameters for image edit credit deduction
 */
export interface DeductImageEditCreditsParams extends DeductCreditsWithOrgSupportParams {
  type: 'image_edit_usage';
}

/**
 * Parameters for video generation credit deduction
 */
export interface DeductVideoGenerationCreditsParams extends DeductCreditsWithOrgSupportParams {
  type: 'video_generation_usage';
}

/**
 * Parameters for text generation credit deduction
 */
export interface DeductTextGenerationCreditsParams extends DeductCreditsWithOrgSupportParams {
  type: 'text_generation_usage';
  /** Input tokens used */
  inputTokens: number;
  /** Output tokens used */
  outputTokens: number;
}

/**
 * Parameters for sound-effects credit deduction. Quest-less: sound generation
 * is a stateless API call with only a synthetic sessionId, so it extends the
 * common base rather than the quest-scoped one.
 */
export interface DeductSoundEffectsCreditsParams extends DeductCreditsCommonParams {
  type: 'sound_effects_usage';
}

/**
 * Union type of all deduction parameter types
 */
export type DeductCreditsParams =
  | DeductImageGenerationCreditsParams
  | DeductImageEditCreditsParams
  | DeductVideoGenerationCreditsParams
  | DeductTextGenerationCreditsParams
  | DeductSoundEffectsCreditsParams;

/**
 * Database adapters required for credit deduction.
 *
 * `users` only needs `ICreditHolderMethods` (incrementCredits method),
 * not the full `IUserRepository`, so the utility works with the
 * partial repository types used in ChatCompletionProcess.
 */
export interface DeductCreditsAdapters {
  db: {
    creditTransactions: ICreditTransactionRepository;
    users: ICreditHolderMethods;
    organizations: IOrganizationRepository;
  };
}

/**
 * Deduct credits with full organization support.
 *
 * This utility centralizes credit deduction logic and handles:
 * 1. Determining whether to deduct from user or organization
 * 2. Updating AND persisting userDetails tracking within the organization
 * 3. Calling subtractCredits with the appropriate parameters
 *
 * @param params - The deduction parameters including user, organization, and credit details
 * @param adapters - Database adapters for credit operations
 */
/**
 * Optional options for credit deduction.
 * Used when the balance has already been adjusted atomically (reservation pattern).
 */
export interface DeductCreditsOptions {
  /**
   * If true, skip the balance update (incrementCredits call).
   * The transaction record will still be created for audit trail purposes.
   * When skipBalanceUpdate is true, you must provide currentCreditHolder.
   */
  skipBalanceUpdate?: boolean;
  /**
   * The current credit holder entity after reconciliation, required when skipBalanceUpdate is true.
   */
  currentCreditHolder?: ICreditHolder;
}

export async function deductCreditsWithOrgSupport(
  params: DeductCreditsParams,
  adapters: DeductCreditsAdapters,
  options?: DeductCreditsOptions
): Promise<void> {
  const { user, organization, credits, sessionId, model, type } = params;
  const source: CompletionSource = params.source ?? 'web';

  let ownerId = user.id;
  let ownerType = CreditHolderType.User;
  let creditHolderMethods: ICreditHolderMethods = adapters.db.users;

  if (organization) {
    // Enforce per-member credit cap if configured
    // NOTE: Known TOCTOU - pre-check and atomic increment are separate operations.
    // A concurrent request can exceed the limit by one. Accepted: window is tiny, stakes are low.
    if (organization.maxCreditsPerMember != null) {
      const userDetails = organization.userDetails?.find(u => u.id === user.id);
      const usedCredits = userDetails?.usedCredits ?? 0;
      if (usedCredits + credits > organization.maxCreditsPerMember) {
        throw new BadRequestError('Organization member credit limit reached');
      }
    }

    ownerId = organization.id;
    ownerType = CreditHolderType.Organization;
    creditHolderMethods = adapters.db.organizations;

    // Atomically increment per-user usage tracking within the organization.
    // Uses $inc to avoid race conditions with concurrent requests.
    await adapters.db.organizations.updateUserDetails(organization.id, user.id, {
      creditsDelta: credits,
      lastCreditUsedAt: new Date(),
    });
  }

  const baseParams = {
    ownerId,
    ownerType,
    credits,
    sessionId,
    model,
    source,
  };

  let transactionParams: SubtractCreditsParameters;

  if (type === 'text_generation_usage') {
    transactionParams = {
      ...baseParams,
      type: 'text_generation_usage',
      questId: params.questId,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
    };
  } else if (type === 'sound_effects_usage') {
    // Quest-less: sound effects has no questId.
    transactionParams = { ...baseParams, type: 'sound_effects_usage' };
  } else {
    // Quest-scoped image/edit/video types; questId is guaranteed by their param shape.
    transactionParams = {
      ...baseParams,
      type,
      questId: params.questId,
    } as SubtractCreditsParameters;
  }

  await subtractCredits(transactionParams, {
    db: {
      creditTransactions: adapters.db.creditTransactions,
    },
    creditHolderMethods,
    skipBalanceUpdate: options?.skipBalanceUpdate,
    currentCreditHolder: options?.currentCreditHolder,
  });
}

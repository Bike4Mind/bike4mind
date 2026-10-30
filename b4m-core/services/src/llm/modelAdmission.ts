import {
  getTextModelCreditsPer1M,
  hasDeveloperUserTag,
  MODEL_REQUIRES_SUBSCRIPTION_ERROR_CODE,
  PAID_PLAN_ENTITLEMENT_KEY,
  ServiceUnavailableError,
  type IAdminSettingsRepository,
  type LLMModelConfig,
  type ModelInfo,
} from '@bike4mind/common';
import { BadRequestError, ForbiddenError, getSettingsMap, getSettingsValue, isModelAccessible } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { aiAccessDeniedMessage, type AiAccessStateFields } from '../userService/accountState';

export type ModelAdmissionInput = {
  user: AiAccessStateFields & { isAdmin?: boolean | null; tags?: string[] | null };
  /** The llmModelConfigurations admin setting. */
  configs: LLMModelConfig[];
  getEntitlements?: () => Promise<string[]>;
  /** The resolved catalog; when given, a disabled or (credits on) unpriced text model is refused. */
  models?: ModelInfo[];
  /** The enforceCredits admin setting. */
  enforceCredits?: boolean;
  /**
   * The free-tier allowlist from loadFreeTierAllowedModels; undefined when the gate is off. While set,
   * a model of any modality outside it needs the PAID_PLAN_ENTITLEMENT_KEY entitlement (admins and developers exempt).
   */
  freeTierAllowedModels?: ReadonlySet<string>;
};

export type ModelAdmission = {
  /** Throws ForbiddenError when the user's AI access is revoked, so fallback selection surfaces the real reason. */
  admits(modelId: string): Promise<boolean>;
  /** Throws BadRequestError (disabled) or ForbiddenError (AI access revoked / not accessible / paid-only / unpriced). */
  assert(modelId: string): Promise<void>;
};

/** The llmModelConfigurations admin setting; an unreadable or missing setting reads as no configs. */
export async function loadModelConfigurations(
  adminSettings: Pick<IAdminSettingsRepository, 'findOne'>
): Promise<LLMModelConfig[]> {
  try {
    const setting = await adminSettings.findOne({ settingName: 'llmModelConfigurations' });
    return Array.isArray(setting?.settingValue) ? (setting.settingValue as LLMModelConfig[]) : [];
  } catch (error) {
    // Fails open by product decision; the warning separates "no gates configured" from "config read failed".
    Logger.warn(
      'modelAdmission: llmModelConfigurations read failed; admitting models as if no gates are configured',
      error
    );
    return [];
  }
}

/**
 * The models a free account may call, across all modalities and in admin order, or undefined when the gate is off.
 * A read failure propagates: this gate fails closed. The Default API Model is not added (see
 * resolveCallerDefaultModel in apps/client/server/utils/callerModelList.ts).
 */
export async function loadFreeTierAllowedModels(
  adminSettings: Pick<IAdminSettingsRepository, 'findAll' | 'findBySettingNames'>
): Promise<ReadonlySet<string> | undefined> {
  const settings = await getSettingsMap(
    { adminSettings },
    { names: ['freeTierModelGateEnabled', 'freeTierAllowedModels'] }
  );
  if (getSettingsValue('freeTierModelGateEnabled', settings) !== true) return undefined;
  return new Set(getSettingsValue('freeTierAllowedModels', settings) ?? []);
}

/** Whether an admission error is the free-tier refusal, as opposed to any other reason a model is refused. */
export function isModelRequiresSubscriptionError(error: unknown): error is ForbiddenError {
  if (!(error instanceof ForbiddenError)) return false;
  return error.additionalInfo?.errorCode === MODEL_REQUIRES_SUBSCRIPTION_ERROR_CODE;
}

/** Admins and developer-tagged users are never held to the free-tier allowlist. */
export function isFreeTierExempt(user: Pick<ModelAdmissionInput['user'], 'isAdmin' | 'tags'>): boolean {
  return Boolean(user.isAdmin) || hasDeveloperUserTag(user.tags);
}

/**
 * Whether a free account may call the model, regardless of modality or catalog presence.
 */
export function isFreeTierModel(modelId: string, allowedModels: ReadonlySet<string>): boolean {
  return allowedModels.has(modelId);
}

/** A text model with no usable per-token price settles at $0, so it cannot run while credits are enforced. */
export function isUnpricedTextModel(model: ModelInfo): boolean {
  return model.type === 'text' && !model.freeToRun && getTextModelCreditsPer1M(model) === null;
}

/**
 * The single model-admission rule for every model-selection path: chat primary (ChatCompletionInvoke),
 * client and automatic fallbacks, the deprecated-id remap (ChatCompletionProcess), executeCompletion
 * (cliCompletions), the agent executor, and the routes metered by
 * apps/client/server/billing/meterPlatformCompletion.ts. A model with no config entry is admitted;
 * entitlements are resolved lazily, only when they can change the outcome. A failed read yields [] for the
 * config gate; the free-tier gate answers it with a retryable ServiceUnavailableError, not an upgrade prompt.
 */
export function createModelAdmission({
  user,
  configs,
  getEntitlements,
  models,
  enforceCredits,
  freeTierAllowedModels,
}: ModelAdmissionInput): ModelAdmission {
  const isAdmin = user.isAdmin || false;
  let entitlementKeys: Promise<string[]> | undefined;
  let entitlementReadFailed = false;
  const resolveEntitlements = (): Promise<string[]> =>
    (entitlementKeys ??= (getEntitlements?.() ?? Promise.resolve([])).catch(error => {
      entitlementReadFailed = true;
      Logger.warn('modelAdmission: entitlement read failed; cannot verify the plan for the free-tier gate', error);
      return [];
    }));

  const requiresPaidPlan = async (modelId: string): Promise<boolean> => {
    if (!freeTierAllowedModels || isFreeTierExempt(user)) return false;
    if (isFreeTierModel(modelId, freeTierAllowedModels)) return false;
    return !(await resolveEntitlements()).includes(PAID_PLAN_ENTITLEMENT_KEY);
  };

  const assertAiAccess = (): void => {
    const message = aiAccessDeniedMessage(user);
    if (message) throw new ForbiddenError(message);
  };

  const refusal = async (modelId: string): Promise<Error | null> => {
    const model = models?.find(m => m.id === modelId);
    if (model?.disabled) {
      return new BadRequestError(
        `Model "${model.id}" is currently unavailable${model.disabledReason ? `: ${model.disabledReason}` : ''}`
      );
    }
    const config = configs.find(c => c.id === modelId);
    if (config) {
      const needsEntitlements = !isAdmin && (config.allowedEntitlements?.length ?? 0) > 0;
      const keys = needsEntitlements ? await resolveEntitlements() : [];
      if (!isModelAccessible(config, user.tags || [], isAdmin, keys)) {
        return new ForbiddenError(`Model "${modelId}" is not accessible and no fallback available`);
      }
    }
    if (await requiresPaidPlan(modelId)) {
      if (entitlementReadFailed) {
        return new ServiceUnavailableError(`Could not verify your plan for model "${modelId}". Please try again.`);
      }
      return new ForbiddenError(
        `Model "${modelId}" requires a paid plan. Upgrade your plan to use it, or choose one of the free-tier models.`,
        { errorCode: MODEL_REQUIRES_SUBSCRIPTION_ERROR_CODE }
      );
    }
    if (enforceCredits && model && isUnpricedTextModel(model)) {
      return new ForbiddenError(`Model "${modelId}" has no price configured and cannot be used`);
    }
    return null;
  };

  return {
    async admits(modelId) {
      assertAiAccess();
      return (await refusal(modelId)) === null;
    },
    async assert(modelId) {
      assertAiAccess();
      const error = await refusal(modelId);
      if (error) throw error;
    },
  };
}

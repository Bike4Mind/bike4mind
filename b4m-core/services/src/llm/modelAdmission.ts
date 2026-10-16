import {
  getTextModelCreditsPer1M,
  type IAdminSettingsRepository,
  type LLMModelConfig,
  type ModelInfo,
} from '@bike4mind/common';
import { BadRequestError, ForbiddenError, isModelAccessible } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';

const logger = new Logger({ metadata: { component: 'modelAdmission' } });

export type ModelAdmissionInput = {
  user: { isAdmin?: boolean | null; tags?: string[] | null };
  /** The llmModelConfigurations admin setting. */
  configs: LLMModelConfig[];
  getEntitlements?: () => Promise<string[]>;
  /** The resolved catalog; when given, a disabled or (credits on) unpriced text model is refused. */
  models?: ModelInfo[];
  /** The enforceCredits admin setting. */
  enforceCredits?: boolean;
};

export type ModelAdmission = {
  admits(modelId: string): Promise<boolean>;
  /** Throws BadRequestError (disabled) or ForbiddenError (not accessible / unpriced). */
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
    logger.warn('llmModelConfigurations read failed; admitting models as if no gates are configured', error);
    return [];
  }
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
 * entitlements are resolved lazily, only when they can change the outcome, and fail safe to [].
 */
export function createModelAdmission({
  user,
  configs,
  getEntitlements,
  models,
  enforceCredits,
}: ModelAdmissionInput): ModelAdmission {
  const isAdmin = user.isAdmin || false;
  let entitlementKeys: Promise<string[]> | undefined;

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
      const keys = needsEntitlements
        ? await (entitlementKeys ??= (getEntitlements?.() ?? Promise.resolve([])).catch(() => []))
        : [];
      if (!isModelAccessible(config, user.tags || [], isAdmin, keys)) {
        return new ForbiddenError(`Model "${modelId}" is not accessible and no fallback available`);
      }
    }
    if (enforceCredits && model && isUnpricedTextModel(model)) {
      return new ForbiddenError(`Model "${modelId}" has no price configured and cannot be used`);
    }
    return null;
  };

  return {
    admits: async modelId => (await refusal(modelId)) === null,
    async assert(modelId) {
      const error = await refusal(modelId);
      if (error) throw error;
    },
  };
}

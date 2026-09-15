import { ModelInfo } from '../../models';

export interface LLMModelConfig extends ModelInfo {
  enabled: boolean;
  allowedUserTags: string[];
  /**
   * Entitlement keys (e.g. `medlib:pro`) that grant access to this model,
   * mirroring the Q3b data-lake `requiredEntitlement` rule. Access is any-of:
   * a non-admin reaches the model if userTags overlap allowedUserTags OR
   * entitlementKeys overlap allowedEntitlements. Unset means tag-only gating
   * (pre-entitlement behavior), so a tag-less subscriber can still reach a
   * model via any `<product>:pro` key.
   */
  allowedEntitlements?: string[];
  fallbackModel?: string;
}

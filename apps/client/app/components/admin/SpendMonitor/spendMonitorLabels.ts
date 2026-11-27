import type { SpendFreezeScopeType, SpendRollupScopeType, SpendRuleId } from '@bike4mind/common';

export const SCOPE_TYPE_LABELS: Record<SpendRollupScopeType, string> = {
  platform: 'Platform',
  User: 'User',
  Organization: 'Organization',
  Agent: 'Agent',
  apiKey: 'API key',
  model: 'Model',
};

export const RULE_LABELS: Record<SpendRuleId, string> = {
  platform_spike: 'Platform spike',
  platform_cost_spike: 'Platform cost spike',
  account_spike: 'Spike',
  account_ceiling: 'Ceiling',
  apikey_spike: 'Spike',
  apikey_ceiling: 'Ceiling',
};

export const FREEZE_SCOPE_OPTIONS: readonly { value: SpendFreezeScopeType; label: string }[] = [
  { value: 'User', label: 'User' },
  { value: 'Organization', label: 'Organization' },
  { value: 'apiKey', label: 'API key' },
];

export const isFreezeScopeType = (scopeType: string): scopeType is SpendFreezeScopeType =>
  FREEZE_SCOPE_OPTIONS.some(option => option.value === scopeType);

const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;
export const isObjectId = (value: string): boolean => OBJECT_ID_PATTERN.test(value);

export const FREEZE_UNDO_REASON = 'Undo: freeze applied by mistake';
export const LIFT_UNDO_REASON = 'Undo: freeze lifted by mistake';

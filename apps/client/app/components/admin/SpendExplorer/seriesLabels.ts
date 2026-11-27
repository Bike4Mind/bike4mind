import type { SpendSegment, SpendSplitDimension } from '@bike4mind/common';

export const SPLIT_OPTIONS: ReadonlyArray<{ value: SpendSplitDimension; label: string }> = [
  { value: 'provider', label: 'Provider' },
  { value: 'segment', label: 'Account type' },
  { value: 'model', label: 'Model' },
  { value: 'feature', label: 'Feature' },
  { value: 'source', label: 'Source' },
  { value: 'funding', label: 'Funding' },
];

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  bedrock: 'Bedrock (AWS)',
};

export const SEGMENT_LABELS: Record<SpendSegment, string> = {
  internal: 'Internal',
  partner: 'Partner',
  customer: 'Customer',
  platform: 'Platform operations',
};

const FUNDING_LABELS: Record<string, string> = {
  granted: 'Granted credits',
  paid: 'Paid credits',
  unknown: 'Unattributed',
  platform: 'Platform operations',
};

const sentenceCase = (value: string) => {
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

/** Display label for one series key under a split. Model ids stay verbatim. */
export function seriesLabel(split: SpendSplitDimension, key: string): string {
  if (key === 'other') return 'Other';
  switch (split) {
    case 'provider':
      return PROVIDER_LABELS[key] ?? sentenceCase(key);
    case 'segment':
      return SEGMENT_LABELS[key as SpendSegment] ?? sentenceCase(key);
    case 'funding':
      return FUNDING_LABELS[key] ?? sentenceCase(key);
    case 'source':
      return key === 'cli' || key === 'api' || key === 'mcp' ? key.toUpperCase() : sentenceCase(key);
    case 'model':
      return key;
    case 'feature':
      return sentenceCase(key);
  }
}

export const providerLabel = (provider: string) => seriesLabel('provider', provider);

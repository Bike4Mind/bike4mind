import type {
  AdminModelAccess,
  AdminModelFixAction,
  AdminModelPrice,
  AdminModelSource,
  AdminModelStatus,
  AdminModelView,
} from '@bike4mind/common';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';

/** Labels and tones for the server's status codes; the reasons and their copy come from the server. */
export const MODEL_STATUS_LABEL: Record<AdminModelStatus, string> = {
  listed: 'Listed',
  limited: 'Limited',
  'needs-review': 'Needs review',
  hidden: 'Hidden',
  retiring: 'Retiring',
  retired: 'Retired',
};

export const MODEL_STATUS_TONE: Record<AdminModelStatus, AdminStatusTone> = {
  listed: 'good',
  limited: 'neutral',
  'needs-review': 'warn',
  hidden: 'neutral',
  retiring: 'warn',
  retired: 'neutral',
};

export const MODEL_VIEW_LABEL: Record<AdminModelView, string> = {
  all: 'All',
  'needs-review': 'Needs review',
  listed: 'Listed',
  hidden: 'Hidden',
  retiring: 'Retiring',
};

export const MODEL_SOURCE_LABEL: Record<AdminModelSource, string> = {
  default: 'Default',
  discovered: 'Discovered',
  admin: 'Set by admin',
};

export const MODEL_FIX_ACTION_LABEL: Record<AdminModelFixAction, string> = {
  'turn-on': 'Turn on',
  'add-price': 'Add price',
  'run-discovery': 'Run discovery',
  'review-lifecycle': 'Review suggestion',
  'open-key-settings': 'Open key settings',
};

const TYPE_LABEL: Record<string, string> = {
  text: 'Text',
  image: 'Image',
  video: 'Video',
  music: 'Music',
  embedding: 'Embedding',
  'speech-to-text': 'Speech to text',
  'text-to-speech': 'Text to speech',
};

/** "Text", "Image", "Speech to text"; an unknown type is shown as stored, first letter raised. */
export const modelTypeLabel = (type: string): string =>
  TYPE_LABEL[type] ?? (type ? type[0].toUpperCase() + type.slice(1).replace(/-/g, ' ') : 'Unknown');

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

export type AccessSummary = { label: string; tone: AdminStatusTone; adminsOnly: boolean };

/**
 * The Access column: who can pick the model. "Admins only" is a hazard (an enabled model no user can reach), so
 * it carries the bad tone instead of reading as an ordinary restriction.
 */
export const accessSummary = (access: AdminModelAccess, baseKey = 'base'): AccessSummary => {
  const { entry } = access;
  const lock = access.freeTierLocked ? ', free tier locked' : '';
  if (entry && !entry.enabled) return { label: 'Off', tone: 'neutral', adminsOnly: false };
  if (access.adminsOnly) return { label: 'Admins only', tone: 'bad', adminsOnly: true };
  if (access.everyone) return { label: `Everyone${lock}`, tone: 'neutral', adminsOnly: false };
  const entitlements = (entry?.allowedEntitlements ?? []).filter(key => key !== baseKey);
  const tags = entry?.allowedUserTags ?? [];
  const parts = [
    ...(entitlements.length > 0
      ? [entitlements.length <= 2 ? entitlements.join(', ') : plural(entitlements.length, 'entitlement')]
      : []),
    ...(tags.length > 0 ? [plural(tags.length, 'tag')] : []),
  ];
  return { label: `${parts.join(' + ') || 'Restricted'}${lock}`, tone: 'neutral', adminsOnly: false };
};

const usd = (value: number) =>
  value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
  });

/** The first tier: the price below every threshold. */
const baseTier = (pricing: AdminModelPrice['pricing']) => {
  const keys = Object.keys(pricing).sort((a, b) => Number(a) - Number(b));
  return keys.length > 0 ? pricing[keys[0]] : undefined;
};

/**
 * Provider cost per unit for the Price column: per 1M tokens in and out for a token price, per image or minute
 * otherwise. A build-table price on a non-text model is shown by source only; its unit is not on the wire.
 */
export const priceSummary = (price: AdminModelPrice | null, type: string): string => {
  if (!price) return '-';
  const tier = baseTier(price.pricing);
  if (!tier) return '-';
  const unit = price.source === 'row' ? price.unit : type === 'text' ? 'per_token' : undefined;
  if (unit === 'per_token') {
    const tiered = Object.keys(price.pricing).length > 1 ? ' (tiered)' : '';
    return `${usd(tier.input * 1e6)} / ${usd(tier.output * 1e6)}${tiered}`;
  }
  if (unit === 'per_image') return `${usd(tier.input)} / image`;
  if (unit === 'per_minute') return `${usd(tier.input)} / min`;
  return 'Build table';
};

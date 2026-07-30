import { ModelBackend, type ModelRecord } from '@bike4mind/common';
import { DISPATCHABLE_ADAPTER_FAMILIES } from '@bike4mind/llm-adapters';
import type { DiscoveryAutoEnablePolicy, DiscoveryCredentials, PromotionBlocker } from './types';

/** Set on a record discovery will not promote, so pickers stay closed until it can. */
export const AWAITING_PRICE_REASON = 'discovered, awaiting price';
export const AWAITING_APPROVAL_REASON = 'discovered, awaiting admin approval';
export const NOT_INVOCABLE_REASON = 'discovered, not invocable by this build';

/**
 * Which backends a deployment credential unlocks. Bedrock and AWS are IAM-only,
 * which is one flag rather than a key; VoyageAI has a key but no listing path, so
 * the promotion clause reads it the same way every other backend is read.
 *
 * MUST COVER EVERY ModelBackend. A backend missing from here has no credential
 * clause it can ever satisfy, so every model discovery finds for it stays
 * `discovered` forever - and because `isDispatchBlocked` wins in `reasonFor`, the
 * admin queue reports "not invocable by this build" and never mentions the
 * credential. Exported for the coverage test that enforces this.
 */
export const CREDENTIAL_OF_BACKEND: Record<string, (creds: DiscoveryCredentials) => boolean> = {
  [ModelBackend.OpenAI]: creds => creds.openai !== null,
  [ModelBackend.Anthropic]: creds => creds.anthropic !== null,
  [ModelBackend.Gemini]: creds => creds.gemini !== null,
  [ModelBackend.XAI]: creds => creds.xai !== null,
  [ModelBackend.Kimi]: creds => creds.kimi !== null,
  [ModelBackend.BFL]: creds => creds.bfl !== null,
  [ModelBackend.VoyageAI]: creds => creds.voyageai !== null,
  [ModelBackend.Ollama]: creds => creds.ollama !== null,
  [ModelBackend.LocalImage]: creds => creds.imageGen !== null,
  [ModelBackend.Bedrock]: creds => creds.awsIam,
  [ModelBackend.AWS]: creds => creds.awsIam,
};

export interface PromotionInput {
  record: Pick<ModelRecord, 'backend' | 'adapterFamily' | 'dispatchProfile' | 'reasoning' | 'freeToRun'>;
  policy: DiscoveryAutoEnablePolicy;
  credentials: DiscoveryCredentials;
  /** A price from a trusted tier: a provider API, or two aggregators that agree. */
  hasTrustedPrice: boolean;
}

export interface PromotionDecision {
  promote: boolean;
  /** Every failed clause, not just the first: the admin queue needs the whole list. */
  blockedBy: PromotionBlocker[];
  /** autoDisabledReason for a denial, or undefined when the record is promoted. */
  autoDisabledReason?: string;
}

/**
 * Is the dispatch profile complete for the family that will build the request?
 *
 * MUST STAY IN SYNC WITH the per-family request builders: a field a builder
 * starts reading has to be required here, or promotion will hand it a record
 * that mis-shapes the request (the failure mode that ran three days live in the
 * GPT-5 rollout). Zod already requires maxTokensParam and toolTransport on every
 * profile, so the only extra clause is the one the profile alone cannot express.
 */
function dispatchProfileGaps(record: PromotionInput['record']): PromotionBlocker[] {
  const profile = record.dispatchProfile;
  if (!profile) return ['no-dispatch-profile'];
  if (!profile.maxTokensParam || !profile.toolTransport) return ['incomplete-dispatch-profile'];
  // An effort-style reasoner with no effort map has nothing to translate its
  // effort levels into, so the request goes out with a level the API rejects.
  if (record.reasoning?.style === 'openai-effort' && !profile.effortMapVariant) {
    return ['incomplete-dispatch-profile'];
  }
  return [];
}

/**
 * The invocability contract (sec 5.4), evaluated as one predicate so promotion is
 * fail-closed everywhere. A record that fails any clause stays 'discovered' with
 * the failed clauses recorded - "why is this model not selectable" is answerable
 * from the run report instead of from a code read.
 */
export function evaluatePromotion({ record, policy, credentials, hasTrustedPrice }: PromotionInput): PromotionDecision {
  const blockedBy: PromotionBlocker[] = [];

  if (!record.adapterFamily) blockedBy.push('no-adapter-family');
  else if (!DISPATCHABLE_ADAPTER_FAMILIES.includes(record.adapterFamily)) blockedBy.push('family-not-dispatchable');

  blockedBy.push(...dispatchProfileGaps(record));

  // A model that costs nothing cannot be mispriced, so 'priced' does not strand
  // the local models a self-host install exists to run.
  const priceSatisfied = policy === 'all' || hasTrustedPrice || record.freeToRun === true;
  if (policy === 'manual') blockedBy.push('manual-approval-required');
  else if (!priceSatisfied) blockedBy.push('no-trusted-price');

  const hasCredential = CREDENTIAL_OF_BACKEND[record.backend]?.(credentials) ?? false;
  if (!hasCredential) blockedBy.push('no-credential-for-backend');

  if (blockedBy.length === 0) return { promote: true, blockedBy };
  return { promote: false, blockedBy, autoDisabledReason: reasonFor(blockedBy) };
}

/** The dispatch clauses; a denial by any of them is a work item, not a data gap. */
const DISPATCH_BLOCKERS: readonly PromotionBlocker[] = [
  'no-adapter-family',
  'family-not-dispatchable',
  'no-dispatch-profile',
  'incomplete-dispatch-profile',
];

export const isDispatchBlocked = (blockedBy: readonly PromotionBlocker[]): boolean =>
  blockedBy.some(blocker => DISPATCH_BLOCKERS.includes(blocker));

function reasonFor(blockedBy: readonly PromotionBlocker[]): string {
  if (isDispatchBlocked(blockedBy)) return NOT_INVOCABLE_REASON;
  if (blockedBy.includes('manual-approval-required')) return AWAITING_APPROVAL_REASON;
  if (blockedBy.includes('no-trusted-price')) return AWAITING_PRICE_REASON;
  return `discovered, ${blockedBy.join(', ')}`;
}

import { ORGANIZATION_OWNER_ONLY_FIELDS, ORGANIZATION_SECRET_FIELDS } from '@bike4mind/common';

/**
 * Per-collection Mongo projection exclusions for the WS data-subscribe handler.
 *
 * quests: a quest's promptMeta.functionCalls[].returnValue can hold verbatim tool output
 * (private corpus chunks, file contents - see redactFunctionCallsForViewer in @bike4mind/common).
 * This subscription's scope is broader than the sharing-based read check elsewhere (it admits
 * any isGlobalRead session via accessibleBy), so it is stripped at the query-projection level
 * here rather than trusting every future subscriber to redact it themselves. `isQuestOwner` skips
 * the exclusion for the session's own owner: the client cache merges a WS quest update as a
 * top-level spread (react-query.ts), so an unconditional exclusion replaced the owner's own
 * cached returnValue with nothing the moment any live update landed, not just a sharee's.
 *
 * organizations: the subscription streams raw org documents, so it has to reproduce what
 * `toSafeOrganization` applies on every REST path - it reads the same two field lists so the
 * transports cannot drift. `stripeCustomerId` is dropped for everyone. `billingContact` is kept
 * only for a platform admin, NOT for an org owner as the REST serializer does: a Mongo projection
 * is per-query, not per-document, so an owner-keyed keep would also hand over the billing contact
 * of every co-member org the same subscription happens to match. An owner's own billing contact
 * still reaches them through the access-gated REST GET.
 */
export type FieldLimitOptions = {
  /** Passed in rather than hardcoded so a collection rename can't silently drop the exclusion. */
  questCollectionName: string;
  organizationCollectionName: string;
  /** The subscribed session belongs to the caller (see the quests note above). */
  isQuestOwner?: boolean;
  /** Caller is a platform admin, the only viewer a per-query projection can safely privilege. */
  isPlatformAdmin?: boolean;
};

export function resolveFieldLimits(
  collectionName: string,
  { questCollectionName, organizationCollectionName, isQuestOwner = false, isPlatformAdmin = false }: FieldLimitOptions
): Record<string, boolean> | undefined {
  if (collectionName === 'users') {
    return { password: false, stripeCustomerId: false, resetPasswordToken: false };
  }
  if (collectionName === questCollectionName && !isQuestOwner) {
    return { 'promptMeta.functionCalls.returnValue': false, 'promptMeta.functionCalls.error': false };
  }
  if (collectionName === organizationCollectionName) {
    const excluded = [...ORGANIZATION_SECRET_FIELDS, ...(isPlatformAdmin ? [] : ORGANIZATION_OWNER_ONLY_FIELDS)];
    return Object.fromEntries(excluded.map(field => [field, false]));
  }
  return undefined;
}

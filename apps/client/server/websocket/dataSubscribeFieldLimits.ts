import {
  ORGANIZATION_OWNER_ONLY_FIELDS,
  ORGANIZATION_SECRET_FIELDS,
  OWNER_ONLY_PROMPT_META_PROJECTION_PATHS,
} from '@bike4mind/common';

/**
 * Per-collection Mongo projection exclusions for the WS data-subscribe handler.
 *
 * quests: a quest's promptMeta can hold verbatim owner-corpus text - functionCalls[].returnValue
 * (tool output, file contents) and citables[].metadata.fullContext (the retrieved passage behind a
 * citation chip). The excluded paths come from OWNER_ONLY_PROMPT_META_PROJECTION_PATHS in
 * @bike4mind/common, the same lists redactPromptMetaForViewer enforces on the REST paths, so the
 * next owner-only promptMeta field cannot close one transport and leave the other open.
 * This subscription's scope is broader than the sharing-based read check elsewhere (it admits
 * any isGlobalRead session via accessibleBy), so it is stripped at the query-projection level
 * here rather than trusting every future subscriber to redact it themselves. `isQuestOwner` skips
 * the exclusion for the session's own owner: the client cache merges a WS quest update as a
 * top-level spread (react-query.ts), so an unconditional exclusion replaced the owner's own
 * cached returnValue with nothing the moment any live update landed, not just a sharee's.
 * `callback` (the API caller's completion-callback URL and signing key id) is `select: false` on
 * QuestModel, which a change stream ignores, so it is dropped here for EVERY viewer, the owner
 * included: it belongs to the API key that armed it, which may be a collaborator's, not the
 * session owner's. No SPA code reads it, so the owner-cache concern above does not apply.
 *
 * organizations: the subscription streams raw org documents, so it has to reproduce what
 * `toSafeOrganization` applies on every REST path - it reads the same two field lists so the
 * transports cannot drift. `stripeCustomerId` is dropped for everyone. `billingContact` is kept
 * only for a platform admin, NOT for an org owner as the REST serializer does: a Mongo projection
 * is per-query, not per-document, so an owner-keyed keep would also hand over the billing contact
 * of every co-member org the same subscription happens to match. An owner's own billing contact
 * still reaches them through the access-gated REST GET.
 *
 * invites: the subscription matches both invites addressed to the caller and every invite on a
 * project the caller may share, so a raw document carries co-recipients' addresses and addresses
 * resolved from user ids, plus the bearer `token`. The REST paths strip these per document
 * (inviteManager.filterInviteRecipientsToSelf / toSharerInviteViews); a per-query projection cannot,
 * so `recipients` and `typedRecipients` are dropped for every non-admin and `token` for everyone.
 * Client subscribers treat an invite event as a cue to refetch through REST rather than reading it.
 */
/** Quest fields no session viewer should see, the owner included; see the quests note above. */
const QUEST_SERVER_ONLY_FIELDS = ['callback'] as const;

/** Invite fields no subscriber may see, and those only a platform admin may; see the invites note above. */
const INVITE_SECRET_FIELDS = ['token'] as const;
const INVITE_ADMIN_ONLY_FIELDS = ['recipients', 'typedRecipients'] as const;

export type FieldLimitOptions = {
  /** Passed in rather than hardcoded so a collection rename can't silently drop the exclusion. */
  questCollectionName: string;
  organizationCollectionName: string;
  inviteCollectionName: string;
  /** The subscribed session belongs to the caller (see the quests note above). */
  isQuestOwner?: boolean;
  /** Caller is a platform admin, the only viewer a per-query projection can safely privilege. */
  isPlatformAdmin?: boolean;
};

export function resolveFieldLimits(
  collectionName: string,
  {
    questCollectionName,
    organizationCollectionName,
    inviteCollectionName,
    isQuestOwner = false,
    isPlatformAdmin = false,
  }: FieldLimitOptions
): Record<string, boolean> | undefined {
  if (collectionName === 'users') {
    return { password: false, stripeCustomerId: false, resetPasswordToken: false };
  }
  if (collectionName === questCollectionName) {
    const excluded = [...(isQuestOwner ? [] : OWNER_ONLY_PROMPT_META_PROJECTION_PATHS), ...QUEST_SERVER_ONLY_FIELDS];
    return Object.fromEntries(excluded.map(path => [path, false]));
  }
  if (collectionName === organizationCollectionName) {
    const excluded = [...ORGANIZATION_SECRET_FIELDS, ...(isPlatformAdmin ? [] : ORGANIZATION_OWNER_ONLY_FIELDS)];
    return Object.fromEntries(excluded.map(field => [field, false]));
  }
  if (collectionName === inviteCollectionName) {
    const excluded = [...INVITE_SECRET_FIELDS, ...(isPlatformAdmin ? [] : INVITE_ADMIN_ONLY_FIELDS)];
    return Object.fromEntries(excluded.map(field => [field, false]));
  }
  return undefined;
}

const FILTER_COMBINATORS = new Set(['$and', '$or', '$nor']);

/**
 * Field paths in a subscription filter that touch a path `fieldLimits` withholds. A projection only
 * hides a value from the payload; the filter still runs against the full document, so matching on
 * a withheld field (a range on `recipients.pending`, say) would let a subscriber read it back one
 * comparison at a time from which documents arrive. Two paths touch when either is a dotted prefix
 * of the other, which also covers a literal sub-document or `$elemMatch` on a parent field.
 */
export function findWithheldFilterPaths(filter: unknown, fieldLimits: Record<string, boolean> | undefined): string[] {
  const withheld = Object.entries(fieldLimits ?? {})
    .filter(([, keep]) => !keep)
    .map(([path]) => path);
  if (!withheld.length) return [];

  const touches = (path: string) =>
    withheld.some(field => field === path || field.startsWith(`${path}.`) || path.startsWith(`${field}.`));
  const found: string[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (FILTER_COMBINATORS.has(key)) walk(value);
      else if (!key.startsWith('$') && touches(key)) found.push(key);
    }
  };
  walk(filter);
  return found;
}

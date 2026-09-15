import { toSafeOrganization } from '@bike4mind/common';

/**
 * Serialize a populated `organizationId` sub-document through the organization response boundary,
 * passing anything that is not one straight through.
 *
 * `redactUserSecretsForSelf` is a denylist over the USER's own fields and never descends into a
 * populated sub-document, so a route that `.populate('organizationId')` inlines the whole
 * Organization - stripeCustomerId and billingContact included. This is the adapter that routes it
 * through the same serializer every org-returning handler uses.
 *
 * The shape is genuinely uncertain at this seam: `.populate()` yields an org document when the ref
 * resolves, null when it does not, and leaves the bare ObjectId when the path was never populated.
 * That last case is the trap - an ObjectId is also `typeof 'object'`, but its `toJSON()` returns a
 * STRING, which the serializer would spread into a character map. Normalizing first and
 * re-checking is what distinguishes them; a field-name sniff would not survive a lean() result.
 */
export function toSafeOrganizationSubdocument(value: unknown, viewer: { userId: string; isAdmin: boolean }): unknown {
  if (typeof value !== 'object' || value === null) return value;

  const plain =
    typeof (value as { toJSON?: unknown }).toJSON === 'function'
      ? (value as { toJSON: () => unknown }).toJSON()
      : value;
  if (typeof plain !== 'object' || plain === null) return value; // an ObjectId, not an org document

  return toSafeOrganization(plain as Parameters<typeof toSafeOrganization>[0], viewer);
}

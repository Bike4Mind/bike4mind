import type { IDataLakeDocument, IDataLakeRepository } from '@bike4mind/common';
import { CreateDataLakeRequestInput, DATA_LAKES, normalizeEntitlementKey } from '@bike4mind/common';
import { secureParameters, BadRequestError } from '@bike4mind/utils';
import { collidesWithRegistryPrefix, findCollidingPrefixLakes } from './tagPrefixCollision';
import type { z } from 'zod';

type CreateDataLakeParams = z.infer<typeof CreateDataLakeRequestInput>;

interface CreateDataLakeAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'create' | 'find'>;
  };
}

/**
 * Builds the unique join meta-tag. Org-scoped lakes get `datalake:<org>:<slug>`;
 * org-less lakes get `datalake:<slug>`. Because the tag is the uniqueness key,
 * org-less lakes may not share a slug.
 *
 * Exported so read paths can check a persisted row's tag against the one its own slug/org
 * would mint - a row where they disagree did not come through this function.
 */
export function buildDatalakeTag(slug: string, organizationId?: string): string {
  return organizationId ? `datalake:${organizationId}:${slug}` : `datalake:${slug}`;
}

/**
 * Resolves a slug collision within the lake's scope (org) deterministically by
 * appending -1, -2, ... until free. Keeps create idempotent-ish instead of hard-failing.
 *
 * A slug is "taken" if a lake in the same scope holds it OR if it would mint a meta-tag the
 * static registry already owns. The registry has no Mongo documents, so the unique index on
 * `datalakeTag` cannot see that second collision - and the meta-tag is an ownership BYPASS in
 * buildOwnershipConditions, so a lake minting `datalake:<registry-slug>` would read every
 * tenant's files in that registry lake.
 */
async function disambiguateSlug(
  db: CreateDataLakeAdapters['db'],
  baseSlug: string,
  organizationId?: string
): Promise<string> {
  const scope = organizationId ? { organizationId } : { organizationId: { $in: [null, ''] } };
  const reservedTags = new Set(DATA_LAKES.map(lake => lake.datalakeTag));
  for (let attempt = 0; attempt < 50; attempt++) {
    const slug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt}`;
    if (reservedTags.has(buildDatalakeTag(slug, organizationId))) continue;
    const existing = await db.dataLakes.find({ ...scope, slug });
    if (existing.length === 0) return slug;
  }
  throw new BadRequestError(
    `Could not find an available slug for "${baseSlug}" after 50 attempts — choose another name`
  );
}

/**
 * Refuses a `fileTagPrefix` that another lake in scope already matches.
 *
 * Two lakes sharing a prefix share their prefix-tagged files, so permanently deleting one would
 * destroy files that only the other holds - overlap (exact or nested) has no DB-level constraint
 * to stop it. Rejecting rather than auto-suffixing like the slug: `acme:-1` is not a meaningful
 * prefix, and silently rewriting it would change every tag the taxonomy step just showed the user.
 *
 * Read-then-write, so two concurrent creates in one scope can still both pass for an OVERLAPPING
 * (not exact-equal) prefix, or for an org-scope exact match - the correct key for either is
 * conditional (org arm OR creator arm) and overlap-aware, which no single unique index expresses.
 * A same-creator EXACT match is now backstopped by a real unique index on DataLakeModel
 * ({ createdByUserId, fileTagPrefix }), closing that one slice of the race.
 */
async function assertPrefixAvailable(
  db: CreateDataLakeAdapters['db'],
  userId: string,
  rawPrefix: string,
  organizationId?: string
): Promise<void> {
  if (collidesWithRegistryPrefix(rawPrefix)) {
    throw new BadRequestError(
      `Tag prefix "${rawPrefix}" is reserved by a built-in knowledge base - choose a different prefix.`
    );
  }
  const [clash] = await findCollidingPrefixLakes(db, rawPrefix, { createdByUserId: userId, organizationId });
  if (clash) {
    // The clash is named only when the caller created it. An org lake gated by a tag or
    // entitlement the caller lacks is invisible to them everywhere else, and echoing its name
    // here would turn this into a guess-confirm oracle for lakes they cannot read.
    const naming = clash.createdByUserId === userId ? ` ("${clash.name}")` : ' in this organization';
    throw new BadRequestError(
      `Tag prefix "${rawPrefix}" overlaps an existing data lake${naming} - choose a different prefix.`
    );
  }
}

export const createDataLake = async (
  userId: string,
  parameters: CreateDataLakeParams,
  { db }: CreateDataLakeAdapters,
  // The lake's org scope. The route resolves this from the caller's active-switcher org and
  // authorization-validates it (resolveActiveOrg) before passing it here - the service trusts
  // it as an already-checked value and never re-derives it from the raw request body.
  organizationId?: string
): Promise<IDataLakeDocument> => {
  const params = secureParameters(parameters, CreateDataLakeRequestInput);

  // Before the slug work: a rejected prefix should fail fast rather than after resolving a slug.
  await assertPrefixAvailable(db, userId, params.fileTagPrefix, organizationId);

  const slug = await disambiguateSlug(db, params.slug, organizationId);
  const datalakeTag = buildDatalakeTag(slug, organizationId);

  // Lakes start in 'draft'; the first batch flips them to 'active' (one-way).
  const dataLake = await db.dataLakes.create({
    name: params.name,
    slug,
    description: params.description,
    fileTagPrefix: params.fileTagPrefix,
    datalakeTag,
    requiredUserTag: params.requiredUserTag,
    requiredEntitlement: params.requiredEntitlement ? normalizeEntitlementKey(params.requiredEntitlement) : undefined,
    createdByUserId: userId,
    organizationId,
    status: 'draft',
    fileCount: 0,
    totalSizeBytes: 0,
  } as Omit<IDataLakeDocument, 'id' | 'createdAt' | 'updatedAt'>);

  return dataLake;
};

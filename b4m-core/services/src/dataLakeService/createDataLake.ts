import type { IDataLakeAccessGrantRepository, IDataLakeDocument, IDataLakeRepository } from '@bike4mind/common';
import {
  CreateDataLakeRequestInput,
  DATA_LAKES,
  MAX_DATA_LAKE_SLUG_LENGTH,
  normalizeEntitlementKey,
} from '@bike4mind/common';
import { secureParameters, BadRequestError } from '@bike4mind/utils';
import { collidesWithRegistryPrefix, findCollidingPrefixLakes } from './tagPrefixCollision';
import type { z } from 'zod';

type CreateDataLakeParams = z.infer<typeof CreateDataLakeRequestInput>;

interface CreateDataLakeAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'create' | 'find'>;
    dataLakeAccessGrants: Pick<IDataLakeAccessGrantRepository, 'upsertGrant'>;
  };
  logger?: { warn: (msg: string, ...args: unknown[]) => void };
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
 * Whether a persisted lake's `datalakeTag` is one its own slug/org could legitimately carry.
 * Tolerant of BOTH forms on purpose: a lake created org-less keeps its `datalake:<slug>` tag after
 * being promoted into an org, because setLakeVisibility deliberately does NOT re-mint the tag - it
 * is the membership join key, and re-minting would orphan every file that already carries it. So an
 * org-scoped lake is well-formed if its tag matches EITHER the org-qualified form OR the org-less
 * form. Safe because `datalakeTag` is globally unique (a sparse unique index), so accepting the
 * historical org-less form admits no cross-lake collision. Without this tolerance a promoted lake
 * would silently fail the well-formedness screen on the owner-exemption path in
 * getDynamicDataLakeTags and drop out of its own owner's dynamic lake set.
 */
export function isDatalakeTagWellFormed(lake: { datalakeTag: string; slug: string; organizationId?: string }): boolean {
  return (
    lake.datalakeTag === buildDatalakeTag(lake.slug, lake.organizationId) ||
    lake.datalakeTag === buildDatalakeTag(lake.slug, undefined)
  );
}

/**
 * Builds the `<base>-<attempt>` candidate, sized so the RESULT fits MAX_DATA_LAKE_SLUG_LENGTH
 * rather than being appended past it. Disambiguation runs after validation, so an unbounded append
 * persists a slug no other surface treats as legal - notably the `datalake:<slug>` entitlement key,
 * which registry.ts re-checks against MAX_DATA_LAKE_SLUG_LENGTH and therefore reports as unknown,
 * failing an admin's grant closed on a key that is in fact correct.
 *
 * Trailing hyphens are stripped after truncation so a cut landing mid-hyphen cannot produce
 * `...a--1`. That still matches DATA_LAKE_SLUG_REGEX (which permits interior runs) but reads as a
 * typo. The base is regex-guaranteed to start alphanumeric, so the trim can never empty it, and the
 * shortest reachable result is a 1-char base plus a 2-char suffix - still over the 2-char minimum.
 *
 * Truncating means a max-length name loses its tail on collision, and two names sharing a
 * (MAX - suffix.length)-char prefix collapse onto ONE candidate family, so they share the caller's
 * 50-attempt budget instead of each having their own. That is the intended trade - a hash suffix
 * would read worse to the lake's owner - but it is why the caller's exhaustion path is now
 * reachable by lakes with different names.
 */
function withDisambiguatingSuffix(baseSlug: string, attempt: number): string {
  const suffix = `-${attempt}`;
  // Room is derived from `suffix.length`, deliberately, NOT hardcoded to 2: raising the attempt cap
  // into 3-digit territory has to keep fitting with no edit here. Do not "simplify" this to a
  // literal - every test in this file would still pass, and a 3-digit suffix would then persist 61.
  const trimmedBase = baseSlug.slice(0, MAX_DATA_LAKE_SLUG_LENGTH - suffix.length).replace(/-+$/, '');
  return `${trimmedBase}${suffix}`;
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
    const slug = attempt === 0 ? baseSlug : withDisambiguatingSuffix(baseSlug, attempt);
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
  { db, logger }: CreateDataLakeAdapters,
  // The lake's org scope. The route resolves this from the caller's active-switcher org and
  // authorization-validates it (resolveActiveOrg) before passing it here - the service trusts
  // it as an already-checked value and never re-derives it from the raw request body.
  organizationId?: string
): Promise<IDataLakeDocument> => {
  const params = secureParameters(parameters, CreateDataLakeRequestInput);

  // Before the slug work: a rejected prefix should fail fast rather than after resolving a slug.
  await assertPrefixAvailable(db, userId, params.fileTagPrefix, organizationId);

  // Lowercased at the mint point, so a lake can never be created with a mixed-case slug and
  // therefore never with a mixed-case `datalakeTag`. That matters because the meta-tag write gates
  // (`assertCanWriteDataLakeTags` and friends) lowercase their input before an exact-match lookup: a
  // mixed-case stored tag would resolve to no lake and refuse a write its owner is entitled to make.
  // Normalizing here rather than inside `buildDatalakeTag` deliberately leaves that function pure, so
  // the well-formedness comparison in `getDynamicDataLakeTags` still reproduces existing rows exactly
  // and no already-persisted lake is reclassified by this change.
  const slug = await disambiguateSlug(db, params.slug.toLowerCase(), organizationId);
  const datalakeTag = buildDatalakeTag(slug, organizationId);

  // Lakes start in 'draft' and stay invisible to Discover and to retrieval until they have a
  // member file, at which point `recomputeLakeStats` flips them to 'active' (one-way).
  try {
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
      totalChunkedChars: 0,
    } as Omit<IDataLakeDocument, 'id' | 'createdAt' | 'updatedAt'>);

    // Seed the creator's explicit owner grant so the lake is self-describing for the membership
    // view (#1672), succession, and transfer (transfer moves this owner row rather than mutating
    // the immutable createdByUserId). Best-effort by design: management/ownership resolution falls
    // back to createdByUserId when no owner grant exists, so a failed seed leaves the lake correctly
    // owned - it just isn't yet listed as an explicit row. A hard failure here would strand an
    // already-created lake, which is the worse outcome; log so a missing seed is diagnosable rather
    // than silent.
    try {
      await db.dataLakeAccessGrants.upsertGrant({
        dataLakeId: dataLake.id,
        principalType: 'user',
        principalId: userId,
        role: 'owner',
        grantedByUserId: userId,
      });
    } catch (grantErr) {
      logger?.warn(
        '[dataLakes] failed to seed owner access grant for new lake; ownership falls back to createdByUserId',
        { dataLakeId: dataLake.id, err: grantErr }
      );
    }

    return dataLake;
  } catch (err) {
    // A concurrent create by the same user can win the { createdByUserId, fileTagPrefix }
    // unique index between the assertPrefixAvailable read above and this write (that race is
    // this index's whole reason to exist) - map the raw duplicate-key to the same friendly
    // error the read-arm check produces, rather than surfacing a 500. (Same pattern as
    // setLakeVisibility.ts's slug-index race.) Keyed on `keyPattern.fileTagPrefix`, not a bare
    // code check: this collection also has unique indexes on `datalakeTag` and
    // { organizationId, slug } - disambiguateSlug's pre-check makes hitting either of those
    // here vanishingly rare, but a bare code===11000 would still mislabel that rare collision
    // as a prefix overlap.
    if ((err as { code?: number; keyPattern?: Record<string, unknown> })?.code === 11000) {
      const keyPattern = (err as { keyPattern?: Record<string, unknown> }).keyPattern;
      if (keyPattern && 'fileTagPrefix' in keyPattern) {
        throw new BadRequestError(
          `Tag prefix "${params.fileTagPrefix}" overlaps an existing data lake - choose a different prefix.`
        );
      }
    }
    throw err;
  }
};

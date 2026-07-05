import type { IDataLakeDocument, IDataLakeRepository } from '@bike4mind/common';
import { CreateDataLakeRequestInput, normalizeEntitlementKey } from '@bike4mind/common';
import { secureParameters, BadRequestError } from '@bike4mind/utils';
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
 */
function buildDatalakeTag(slug: string, organizationId?: string): string {
  return organizationId ? `datalake:${organizationId}:${slug}` : `datalake:${slug}`;
}

/**
 * Resolves a slug collision within the lake's scope (org) deterministically by
 * appending -1, -2, ... until free. Keeps create idempotent-ish instead of hard-failing.
 */
async function disambiguateSlug(
  db: CreateDataLakeAdapters['db'],
  baseSlug: string,
  organizationId?: string
): Promise<string> {
  const scope = organizationId ? { organizationId } : { organizationId: { $in: [null, ''] } };
  for (let attempt = 0; attempt < 50; attempt++) {
    const slug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt}`;
    const existing = await db.dataLakes.find({ ...scope, slug });
    if (existing.length === 0) return slug;
  }
  throw new BadRequestError(
    `Could not find an available slug for "${baseSlug}" after 50 attempts — choose another name`
  );
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

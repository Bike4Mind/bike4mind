import type { IDataLakeDocument } from '@bike4mind/common';

export type OwnerCandidateLake = Pick<IDataLakeDocument, 'id' | 'organizationId' | 'createdAt'>;

const oldestFirst = (a: OwnerCandidateLake, b: OwnerCandidateLake): number =>
  new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id.localeCompare(b.id);

/**
 * The org that owns a file belonging to `lakes`, or undefined when none of them is org-owned (the
 * file stays personal). A file in several org lakes goes to the lake that ingested it
 * (`sourceLakeId`), else the oldest, with the id breaking a createdAt tie.
 *
 * Shared by createFabFile (over the lakes its tag gate authorized) and the owner backfill
 * (packages/scripts) so both pick the same owner.
 */
export function pickOwnerOrganizationId(
  lakes: readonly OwnerCandidateLake[],
  sourceLakeId?: string
): string | undefined {
  const orgLakes = lakes.filter(lake => !!lake.organizationId);
  const sourceLake = sourceLakeId ? orgLakes.find(lake => lake.id === sourceLakeId) : undefined;
  const ownerLake = sourceLake ?? [...orgLakes].sort(oldestFirst)[0];
  return ownerLake?.organizationId || undefined;
}

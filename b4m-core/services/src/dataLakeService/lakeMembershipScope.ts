import type { DataLakeMembershipScope, IDataLakeDocument } from '@bike4mind/common';

/** The lake fields the membership scope is derived from - always the persisted document. */
type ScopeSourceLake = Pick<IDataLakeDocument, 'datalakeTag' | 'fileTagPrefix' | 'createdByUserId'>;

/**
 * Builds the scope every whole-lake file query and the single-lake browse run on: the lake's
 * meta-tag plus the creator identity its `fileTagPrefix` arm is anchored to.
 *
 * Trivial by design. It exists so no call site assembles the scope by hand and quietly omits
 * `creatorUserId`, which would silently narrow that call back to meta-tag-only matching.
 */
export const lakeMembershipScope = (lake: ScopeSourceLake): DataLakeMembershipScope => ({
  datalakeTag: lake.datalakeTag,
  fileTagPrefix: lake.fileTagPrefix,
  creatorUserId: lake.createdByUserId,
});

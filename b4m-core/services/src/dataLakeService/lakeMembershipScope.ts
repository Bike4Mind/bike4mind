import type { DataLakeConfig, DataLakeMembershipScope, IDataLakeDocument } from '@bike4mind/common';

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
  kind: 'owned',
  datalakeTag: lake.datalakeTag,
  fileTagPrefix: lake.fileTagPrefix,
  creatorUserId: lake.createdByUserId,
});

/**
 * The registry counterpart: a hardcoded DATA_LAKES lake, whose prefix arm is OPEN (no ownership
 * conjunct) because the lake is a shared knowledge base with no creator to anchor to.
 *
 * Takes the registry CONFIG rather than a lake document on purpose. A registry lake has no backing
 * document, and the only prefix safe to match without an ownership arm is the compile-time one -
 * so the signature makes it awkward to pass a user-supplied prefix here by accident.
 */
export const registryMembershipScope = (
  config: Pick<DataLakeConfig, 'datalakeTag' | 'fileTagPrefix'>
): DataLakeMembershipScope => ({
  kind: 'registry',
  datalakeTag: config.datalakeTag,
  fileTagPrefix: config.fileTagPrefix,
});

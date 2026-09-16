import type { DataLakeConfig, DataLakeMembershipScope, IDataLakeDocument } from '@bike4mind/common';
import { isFallbackLake } from './assertLakeAccess';

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

/**
 * The scope for a lake as the ACCESS GATE handed it back, whichever kind that turned out to be.
 * Use this on any path `assertLakeAccess` / `assertLakeRebuildAccess` can reach, because those
 * resolve a DATA_LAKES lake to a synthetic document with `createdByUserId: ''` - and an `owned`
 * scope over a creator-less lake fails closed to meta-tag-only (`effectiveTagPrefixArm`), silently
 * dropping the prefix arm a registry lake is mostly made of.
 *
 * Every path behind `assertLakeWritable` refuses a fallback lake outright, so those can keep
 * calling `lakeMembershipScope` directly; this exists so a path that CAN see a registry lake never
 * open-codes the branch again and gets it wrong on the third try.
 *
 * Two copies remain open-coded on purpose, in `GET /api/data-lakes/:id` and
 * `GET /api/data-lakes/:id/articles`: their tests assert the branch shape at the route, so folding
 * them in is a test-touching change of its own. Keep them in step with this.
 */
export const resolveLakeMembershipScope = (
  lake: ScopeSourceLake & Pick<IDataLakeDocument, 'id'>
): DataLakeMembershipScope => (isFallbackLake(lake) ? registryMembershipScope(lake) : lakeMembershipScope(lake));

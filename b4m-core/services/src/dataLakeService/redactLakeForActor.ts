import type { AccessContext, IDataLake, IDataLakeDocument } from '@bike4mind/common';
import { canManageLake } from './authorizeLakeWrite';

/**
 * The fields a NON-editor reader may receive from a lake document. This is an ALLOW-LIST: the
 * safe default is "withheld", so a field added to `IDataLake` later is not shipped to readers
 * until it is named here on purpose. `systemPrompt` is the field that must never appear (it steers
 * every answer drawn from the lake but is editable only by the lake's editors); it is absent from
 * this list, so `toReaderLake` never emits it.
 *
 * `satisfies readonly (keyof IDataLakeDocument)[]` makes a typo or a renamed field a COMPILE error,
 * and the redaction suite in `dataLakeService.test.ts` pins the served key set at runtime. Neither
 * catches a field added to `IDataLake` and named nowhere - a list of strings has no way to notice
 * an absence - so `LAKE_FIELD_VISIBILITY` below is what forces the decision.
 *
 * Membership deliberately reproduces exactly what a reader receives today (see #1112): the
 * obviously-public fields plus `createdByUserId`, `organizationId`, `requiredUserTag` and
 * `requiredEntitlement`. None is a secret in the sense `systemPrompt` is, and narrowing the set is
 * a behavior change (no consumer was checked for it), so this refactor preserves the current shape.
 */
export const READER_LAKE_FIELDS = [
  'id',
  'createdAt',
  'updatedAt',
  'name',
  'slug',
  'description',
  'fileTagPrefix',
  'datalakeTag',
  'createdByUserId',
  'organizationId',
  'requiredUserTag',
  'requiredEntitlement',
  'isPublic',
  'status',
  'fileCount',
  'totalSizeBytes',
  'lastSyncAt',
] as const satisfies readonly (keyof IDataLakeDocument)[];

/** A lake as served to a non-editor: the allow-listed subset, with `systemPrompt` unreachable. */
export type ReaderDataLake = Pick<IDataLakeDocument, (typeof READER_LAKE_FIELDS)[number]>;

/**
 * Every `IDataLake` field, classified. Keyed by `keyof IDataLake`, so a field added to the entity
 * and classified nowhere is a compile error here - which is the part `READER_LAKE_FIELDS` cannot
 * do, being a list of strings a new field can simply never join. The document-only keys
 * (`id`/`createdAt`/`updatedAt`) are not `IDataLake` fields and stay out; a test pins this against
 * `READER_LAKE_FIELDS` so the two cannot drift.
 *
 * `withheld` is reader-scope only - the field is absent from `READER_LAKE_FIELDS`, not hidden from
 * everyone. An editor is served the whole document, so this map says nothing about what they see.
 * Nor does the map withhold anything itself: `toReaderLake` projects through `READER_LAKE_FIELDS`,
 * and the teeth here are the compile error plus the test pinning the two together.
 */
export const LAKE_FIELD_VISIBILITY: Record<keyof IDataLake, 'reader' | 'withheld'> = {
  name: 'reader',
  slug: 'reader',
  description: 'reader',
  // Steers every answer drawn from the lake, editable only by its editors.
  systemPrompt: 'withheld',
  // Editor-only, like systemPrompt: a reader gets its EFFECT (the prompt activates on a session
  // created for the lake, resolved server-side) but never reads the binding itself.
  preferredSystemPromptId: 'withheld',
  fileTagPrefix: 'reader',
  datalakeTag: 'reader',
  requiredUserTag: 'reader',
  requiredEntitlement: 'reader',
  createdByUserId: 'reader',
  organizationId: 'reader',
  isPublic: 'reader',
  status: 'reader',
  fileCount: 'reader',
  totalSizeBytes: 'reader',
  lastSyncAt: 'reader',
  // Teardown bookkeeping: of no use to a reader, and it reports when the owner tore the lake down.
  filesDeletedAt: 'withheld',
  // Lake-memory producer bookkeeping (#1440): internal lease + continuation cursor. Of no use to a
  // reader, and the lease timestamp would leak when/whether extraction is running.
  lakeMemoryExtractionAt: 'withheld',
  lakeMemoryCursor: 'withheld',
};

/**
 * Project a lake down to the reader allow-list. Only ever emits fields named in
 * `READER_LAKE_FIELDS`, so - unlike an object-rest strip - it cannot leak an unlisted field even
 * if handed a hydrated Mongoose document (whose own-enumerable keys a rest-spread would carry
 * through). Omits absent optionals rather than setting them `undefined`, so the served shape stays
 * clean and `'field' in result` stays meaningful.
 */
function toReaderLake(lake: IDataLakeDocument): ReaderDataLake {
  const reader = {} as Record<string, unknown>;
  for (const field of READER_LAKE_FIELDS) {
    if (lake[field] !== undefined) reader[field] = lake[field];
  }
  return reader as ReaderDataLake;
}

/**
 * Serialize a lake for `actor`. An editor (creator or admin, via `canManageLake`) receives the
 * full document; everyone else receives the reader allow-list (`toReaderLake`), which withholds
 * `systemPrompt` by construction.
 *
 * Redaction is needed because the READ-gated exits are gated on access, which is deliberately wider
 * than manage: `assertLakeAccess` hands back a stranger's PUBLISHED lake (public arm, crosses orgs),
 * and the archived/deleted management views hand an org member a lake they don't own. Every
 * READ-gated exit must therefore pass through here: `GET /api/data-lakes/:id`, `/archived`,
 * `/deleted`. The write/lifecycle paths (POST /api/data-lakes, PUT, DELETE, /visibility, /lifecycle)
 * serialize raw documents too, but each enforces admin-or-creator in its own service first - and a
 * create's author is by definition its editor - so they intentionally do NOT call this. The
 * actor-aware LIST projection has its own gate (see toManageableConfig in listDataLakes) since it
 * returns configs, not documents.
 *
 * For an editor, a blank (empty or whitespace-only) prompt is reported as ABSENT and a
 * padded-but-non-blank prompt is TRIMMED, so this endpoint's answer matches the list projection's (toManageableConfig
 * already normalizes both) - otherwise the same lake reads as "has a prompt" here and "has none"
 * there, and an editor seeding a form from either one gets a different result. The document is
 * returned by identity in the common case (prompt absent or already trimmed) and only copied when
 * stored padding must be normalized, so no caller's document is mutated. `?.trim()` is null-safe:
 * a `null` prompt from a direct DB write or migration is treated as blank, not thrown on.
 */
export function redactLakeForActor(
  lake: IDataLakeDocument,
  actor: Pick<AccessContext, 'userId' | 'isAdmin'>
): IDataLakeDocument | ReaderDataLake {
  if (canManageLake(lake, actor)) {
    const trimmed = lake.systemPrompt?.trim();
    // Blank in any form - unset, null, empty, or whitespace-only - is reported as absent, matching
    // the list projection (toManageableConfig) and getDataLakePrompts. An unset prompt needs no
    // strip, so keep identity; every other blank drops the key so a reader sees "unset".
    if (!trimmed) {
      if (lake.systemPrompt === undefined) return lake;
      // Object-rest spread is safe here (unlike the reader path, which uses the allow-list): this
      // branch runs only for an editor, who is already authorized to see the whole document, so a
      // stray key it fails to drop is at worst their own re-exposed blank prompt - never a leak to
      // an unauthorized reader. Only the reader path needs the leak-proof allow-list projection.
      const { systemPrompt: _blank, ...rest } = lake;
      return rest as IDataLakeDocument;
    }
    // Non-blank: identity when already trimmed (the common case), else a trimmed copy so stored
    // padding isn't echoed only on this path.
    return lake.systemPrompt === trimmed ? lake : { ...lake, systemPrompt: trimmed };
  }
  return toReaderLake(lake);
}

/** `redactLakeForActor` over a list - the archived/deleted management views. */
export function redactLakesForActor(
  lakes: IDataLakeDocument[],
  actor: Pick<AccessContext, 'userId' | 'isAdmin'>
): (IDataLakeDocument | ReaderDataLake)[] {
  return lakes.map(lake => redactLakeForActor(lake, actor));
}

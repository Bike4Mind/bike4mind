import { getAccessibleDataLakes, toDataLakeConfig } from '@bike4mind/common';
import type { IDataLakeDocument } from '@bike4mind/common';
import type { DataLakeAccessContext } from './getDynamicDataLakeTags';

/** A trusted lake's prompt, ready to render as a labeled block. */
export interface DataLakePrompt {
  /** Carried only as the sort tie-break - lake names are not unique (only `slug` is, per org). */
  id: string;
  name: string;
  systemPrompt: string;
}

/**
 * Trust rule for prompt INJECTION - deliberately narrower than read access.
 *
 * Read access has a public arm that crosses org boundaries by design (see
 * findActiveByUserTagsAndEntitlements), so "accessible" includes lakes published by
 * strangers in other orgs. Injecting those prompts would let any publisher put system
 * instructions into an unrelated user's turn - and the prompt text is editor-only, so
 * neither the user nor their org admin could see what is steering the answer. Content
 * from a stranger's public lake is still retrievable; only its INSTRUCTIONS are dropped.
 *
 * Trusted = the caller's own lake, or a lake scoped to the caller's org (the org admin
 * governance path). Consumed by DataLakePromptFeature, which renders the surviving lakes.
 */
function isTrustedForInjection(
  lake: Pick<IDataLakeDocument, 'createdByUserId' | 'organizationId'>,
  actor: { userId?: string; organizationId?: string }
): boolean {
  if (actor.userId && lake.createdByUserId === actor.userId) return true;
  return !!lake.organizationId && !!actor.organizationId && lake.organizationId === actor.organizationId;
}

/**
 * Resolves the per-lake system prompts to inject for a turn: the caller's active,
 * accessible, TRUSTED lakes that carry a non-empty `systemPrompt`.
 *
 * Applies the same accessibility rule as retrieval - the identical DB pre-filter plus
 * `getAccessibleDataLakes` pass that `getDynamicDataLakeAccess` runs - then narrows it with the
 * trust rule above. (That resolver additionally drops lakes whose `datalakeTag` shadows a static
 * registry tag; retrieval-specific, since it guards the tag-based file lookup and prompts never
 * use the tag.)
 *
 * Prompt text is read off the raw lake documents ON PURPOSE: `DataLakeConfig` is the
 * client-facing projection returned by the list endpoints, so putting `systemPrompt` there
 * would leak the text to every lake user (it is editor-only). Keep it out of that type.
 *
 * Fail-safe: a lake read failure yields no prompts rather than failing the turn.
 */
export async function getAccessibleDataLakePrompts(context: DataLakeAccessContext): Promise<DataLakePrompt[]> {
  const repo = context.db.dataLakes;
  if (!repo) return [];

  const userTags = context.user.tags || [];
  const entitlementKeys = context.entitlementKeys ?? [];
  // String-coerce for the same reason getDynamicDataLakeAccess does: a hydrated user doc
  // carries ObjectIds, and the lake's owner/org fields are Strings.
  const organizationId = context.user.organizationId ? String(context.user.organizationId) : undefined;
  const userId = context.user.id ? String(context.user.id) : undefined;

  let lakes: IDataLakeDocument[];
  try {
    lakes = await repo.findActiveByUserTagsAndEntitlements(userTags, entitlementKeys, organizationId, userId);
  } catch (err) {
    context.logger?.warn('[dataLakes] prompt lookup failed; injecting no lake prompts', err);
    return [];
  }
  if (lakes.length === 0) return [];

  const accessibleIds = new Set(
    getAccessibleDataLakes(userTags, lakes.map(toDataLakeConfig), entitlementKeys).map(lake => lake.id)
  );

  return (
    lakes
      .filter(lake => accessibleIds.has(lake.id) && isTrustedForInjection(lake, { userId, organizationId }))
      .map(lake => ({ id: lake.id, name: lake.name, systemPrompt: (lake.systemPrompt ?? '').trim() }))
      .filter(lake => lake.systemPrompt.length > 0)
      // Stable order keeps the rendered prompt byte-identical across turns, so it stays
      // prompt-cache friendly (lake documents come back in no guaranteed order). Tie-break on id:
      // names are not unique, and localeCompare alone would leave same-named lakes free to swap.
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  );
}

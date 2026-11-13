import type { ModelBackend } from '@bike4mind/common';
import { RUNTIME_DISCOVERED_BACKENDS, type ResolvedCatalogRecord } from '@bike4mind/llm-adapters';

/**
 * Lifecycle statuses whose catalog-only model is invisible to GET /api/models. mergeCatalogWithDrops
 * (b4m-core/llm-adapters/src/mergeCatalog.ts) lists a catalog-only model only while it is 'active',
 * and catalogSuccessors offers an upgrade only off 'deprecated' or 'retired'. Allowlisted, so a status
 * added later counts as visible until someone adds it here.
 */
const OFF_LIST_STATUSES: ReadonlySet<unknown> = new Set([undefined, 'discovered', 'unlisted']);

/**
 * Whether a model's merged record keeps it off every model list. A seeded model (adapter tables, or a
 * runtime-listed backend such as Ollama) is listed whatever its catalog status says, so it never is.
 * No record at all is a model with no row: nothing lists it either.
 */
function offList(
  modelId: string,
  record: ResolvedCatalogRecord | undefined,
  staticModelIds: ReadonlySet<string>
): boolean {
  if (staticModelIds.has(modelId)) return false;
  if (!record) return true;
  if (RUNTIME_DISCOVERED_BACKENDS.includes(record.record.backend as ModelBackend)) return false;
  const lifecycle = record.record.lifecycle as { status?: unknown } | undefined;
  return OFF_LIST_STATUSES.has(lifecycle?.status);
}

/**
 * The written models whose rows can change what GET /api/models returns: every one that is not off
 * the list both before and after the writes. A row for a model that stays off the list (discovered
 * and unpromoted, or unlisted) cannot move a picker, so a run that wrote only those changes nothing.
 * Errs toward reporting a change, never toward hiding one.
 */
export function modelListChanges(input: {
  writtenModelIds: Iterable<string>;
  staticModelIds: ReadonlySet<string>;
  before: ReadonlyMap<string, ResolvedCatalogRecord>;
  after: ReadonlyMap<string, ResolvedCatalogRecord>;
}): string[] {
  const { staticModelIds, before, after } = input;
  return [...new Set(input.writtenModelIds)].filter(
    modelId =>
      !offList(modelId, before.get(modelId), staticModelIds) || !offList(modelId, after.get(modelId), staticModelIds)
  );
}

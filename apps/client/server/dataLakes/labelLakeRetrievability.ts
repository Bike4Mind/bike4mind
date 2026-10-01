import type { RetrievalLakeScope } from './resolveRetrievalLakeScope';

/**
 * Label each listed lake with whether `scope` (the caller's chat retrieval scope) reaches it.
 * Keyed on `datalakeTag`, which is globally unique across registry and DB lakes. Rows are never
 * dropped. An incomplete scope (`lakeViewComplete === false`) labels nothing, so a degraded
 * lake read cannot mark a reachable lake unsearchable.
 */
export function labelLakeRetrievability<T extends { datalakeTag: string }>(
  rows: T[],
  scope: RetrievalLakeScope
): Array<T & { retrievable?: boolean }> {
  if (scope.lakeViewComplete === false) return rows;
  const reachable = new Set(scope.lakes.map(lake => lake.datalakeTag));
  return rows.map(row => ({ ...row, retrievable: reachable.has(row.datalakeTag) }));
}

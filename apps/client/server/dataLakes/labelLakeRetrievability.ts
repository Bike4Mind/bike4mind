import type { DataLakeRetrievabilityLabel } from '@bike4mind/common';
import type { RetrievalLakeScope } from './resolveRetrievalLakeScope';

/**
 * Label each listed lake with whether `scope` reaches it (see DataLakeRetrievabilityLabel).
 * Keyed on `datalakeTag`, which is globally unique across registry and DB lakes. Rows are never
 * dropped. An incomplete scope (`lakeViewComplete === false`) labels nothing, so a degraded
 * lake read cannot mark a reachable lake unsearchable.
 */
export function labelLakeRetrievability<T extends { datalakeTag: string }>(
  rows: T[],
  scope: RetrievalLakeScope
): Array<T & DataLakeRetrievabilityLabel> {
  if (scope.lakeViewComplete === false) return rows;
  const reachable = new Set(scope.lakes.map(lake => lake.datalakeTag));
  return rows.map(row => ({ ...row, retrievable: reachable.has(row.datalakeTag) }));
}

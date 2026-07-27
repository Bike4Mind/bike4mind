import type { IModelDiscoveryStateRepository, ModelBackend } from '@bike4mind/common';
import type { ResolvedCatalogRecord } from '@bike4mind/llm-adapters';

export interface AbsencePlan {
  /** Models a successful authoritative source listed this run. */
  sighted: string[];
  /** Models missing from a successful authoritative listing of their own backend. */
  missed: string[];
  /**
   * Backends no successful source claimed authority for. Their models are frozen:
   * a failed or partial fetch neither increments nor resets a miss counter, which
   * is what makes a flaky provider degrade to "no new information" rather than
   * "everything from that provider vanished".
   */
  frozenBackends: string[];
}

export interface AbsenceInput {
  /** Union of authoritativeFor across the sources that SUCCEEDED this run. */
  coveredBackends: ReadonlySet<string>;
  /** Every model id a source reported this run. */
  sightedModelIds: ReadonlySet<string>;
  /** Catalog belief per model, for the backend each one belongs to. */
  base: ReadonlyMap<string, ResolvedCatalogRecord>;
}

/**
 * Phase 2 does the bookkeeping only: sightings reset a streak and misses extend
 * one. No catalog lifecycle transition is derived from absence here - graduation
 * to deprecated after K misses spanning 48h is Phase 4, and it reads these
 * counters rather than recomputing them.
 */
export function planAbsence({ coveredBackends, sightedModelIds, base }: AbsenceInput): AbsencePlan {
  const sighted: string[] = [];
  const missed: string[] = [];
  const seenBackends = new Set<string>();

  for (const [modelId, resolved] of base) {
    const backend = backendOf(resolved);
    if (backend) seenBackends.add(backend);
    if (sightedModelIds.has(modelId)) {
      sighted.push(modelId);
      continue;
    }
    // Absence is only evidence when someone successfully listed that backend.
    if (backend && coveredBackends.has(backend)) missed.push(modelId);
  }

  // A model a source reported that the catalog has never held is still a sighting:
  // its state row is what a later miss streak counts against.
  for (const modelId of sightedModelIds) {
    if (!base.has(modelId)) sighted.push(modelId);
  }

  const frozenBackends = [...seenBackends].filter(backend => !coveredBackends.has(backend)).sort();
  return { sighted: sighted.sort(), missed: missed.sort(), frozenBackends };
}

export async function applyAbsence(
  plan: AbsencePlan,
  repository: Pick<IModelDiscoveryStateRepository, 'recordSighting' | 'recordMiss'>,
  at: Date
): Promise<void> {
  for (const modelId of plan.sighted) await repository.recordSighting(modelId, at);
  for (const modelId of plan.missed) await repository.recordMiss(modelId, at);
}

function backendOf(resolved: ResolvedCatalogRecord): ModelBackend | null {
  const backend = resolved.record.backend;
  return typeof backend === 'string' ? (backend as ModelBackend) : null;
}

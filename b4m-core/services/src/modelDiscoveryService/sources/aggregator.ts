import {
  buildAggregatorKeyIndex,
  resolveAggregatorKey,
  type AggregatorName,
  type ModelIdAliasMap,
} from '@bike4mind/common';
import type { DiscoveryFetchContext } from '../types';

/**
 * One of our models, as the join sees it. Aggregators can neither add nor retire
 * a model (sec 5.5 field authority), so this list - the ids the catalog already
 * holds - is the entire universe they may emit patches for.
 *
 * It is injected at construction rather than read from `DiscoveryFetchContext`
 * because the context deliberately carries no catalog: a source is data handed
 * to the runner, and the driver that already reads `rowsInForce` supplies the
 * thunk.
 */
export interface JoinTarget {
  modelId: string;
  /** Our ModelBackend, which picks the aggregator namespace to search. */
  backend?: string;
}

export type JoinTargetResolver = () => readonly JoinTarget[] | Promise<readonly JoinTarget[]>;

export interface AggregatorSourceOptions {
  targets: JoinTargetResolver;
  /** packages/database/src/seeds/modelIdAliases.json, loaded by the driver. */
  aliases?: ModelIdAliasMap;
}

export interface JoinOutcome<T> {
  /** Our model id -> the aggregator entry it resolved to. */
  matched: Map<string, T>;
  /** Ids no key matched. A work item, not a log line (sec 5.6 item 4). */
  unmatched: string[];
}

/**
 * Resolve every target against one aggregator's key space. Pure given the two
 * inputs, so a coverage number is reproducible from a checked-in fixture.
 */
export function joinTargets<T>(
  targets: readonly JoinTarget[],
  entries: ReadonlyMap<string, T>,
  aggregator: AggregatorName,
  aliases?: ModelIdAliasMap
): JoinOutcome<T> {
  const index = buildAggregatorKeyIndex(entries.keys(), aggregator);
  const matched = new Map<string, T>();
  const unmatched: string[] = [];

  for (const target of targets) {
    const hit = resolveAggregatorKey(target.modelId, index, aliases);
    const entry = hit ? entries.get(hit.key) : undefined;
    if (entry === undefined) unmatched.push(target.modelId);
    else matched.set(target.modelId, entry);
  }

  return { matched, unmatched: unmatched.sort() };
}

/** One line per run so an unmatched id is visible even before the report is read. */
export function logCoverage(ctx: DiscoveryFetchContext, name: string, outcome: JoinOutcome<unknown>): void {
  const total = outcome.matched.size + outcome.unmatched.length;
  ctx.logger.info(`[model-discovery] ${name} joined ${outcome.matched.size}/${total}`);
  if (outcome.unmatched.length > 0) {
    ctx.logger.warn(`[model-discovery] ${name} unmatched: ${outcome.unmatched.join(', ')}`);
  }
}

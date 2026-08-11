/**
 * The single authority that turns an agent execution's tri-state memory flag into concrete
 * `MementoGates` for the agent surface - the read side (`getFirstIterationMementosPreamble`) and the
 * write side (`publishMementoCompletion`) both resolve through here, so neither can re-implement the
 * policy or disagree about what `enableMementos: false` means.
 *
 * It feeds `resolveMementoGates` the same three inputs the chat path feeds it (ChatCompletionProcess):
 * the caller's tri-state request flag, the `EnableMementos` admin setting, and the user's V2 opt-in.
 * That is what makes a per-request opt-out mean the SAME thing on the agent surface as it does on
 * chat - an explicit `false` disables both pipelines, read and write, V1 and V2 (#1337, following the
 * chat-path fix #1319 / #1327).
 *
 * The tri-state on `execution.enableMementos` is load-bearing and must reach here uncoerced:
 * `undefined` (a V2-only user, who lets the opt-in ride) is NOT the same as `false` (an explicit
 * opt-out). Collapsing them with `=== true` is exactly the leak this file closes.
 */

import type { Logger } from '@bike4mind/observability';
import type { IAgentExecution } from '@bike4mind/database';
import type { IAdminSettingsRepository } from '@bike4mind/common';
import { resolveMementoGates, type MementoGates } from '@bike4mind/services';
import { isMementosV2Enabled } from '@server/memory/mementoLedgerMirror';

export type MementoGateExecution = Pick<IAgentExecution, 'userId' | 'enableMementos' | 'resolvedMementoGates'>;

export interface MementoGateAdapters {
  db: { adminSettings: Pick<IAdminSettingsRepository, 'getSettingsValue'> };
}

export interface ResolvedMementoGates extends MementoGates {
  /**
   * True when the V2 opt-in lookup REJECTED, as opposed to returning a legitimate `false`. `v2` is
   * fail-closed to `false` either way, but the write side has to tell them apart: publishing an
   * explicit `enableMementosV2: false` that actually came from a Mongo blip asserts a permanent opt-out
   * to the subscriber, whereas OMITTING the field lets the subscriber resolve the opt-in itself. Before
   * this surface published explicit booleans it always omitted the field when V1 was on, so the
   * subscriber's independent retry was the fallback; keeping that fallback for the failure case is what
   * stops a transient error from silently costing a V2 user a turn of learning.
   */
  v2OptInLookupFailed: boolean;
}

export async function resolveExecutionMementoGates(
  execution: MementoGateExecution,
  adapters: MementoGateAdapters,
  logger: Logger
): Promise<ResolvedMementoGates> {
  // Resolve-once memoization (#1525). When the execution start already resolved and persisted the
  // gates, reuse them verbatim - the read path, the write path, and the stop-at-gate WS handler all
  // route through here, so returning the persisted verdict is what stops a mid-run flip of the admin
  // setting or the V2 opt-in from making those sites disagree. Also skips the two DB reads below.
  if (execution.resolvedMementoGates) return execution.resolvedMementoGates;

  // An explicit per-request opt-out disables both pipelines regardless of the admin setting or the V2
  // opt-in (resolveMementoGates(false, ...) is always { v1: false, v2: false }). It is also the
  // highest-volume input this resolver sees - the Slack senders and the voice proxy all hard-code
  // false - so short-circuiting skips both round trips and keeps the dominant flow off the reads below.
  if (execution.enableMementos === false) return { v1: false, v2: false, v2OptInLookupFailed: false };

  // Both lookups fail closed to "not enabled" (memory degrades, it never fails the turn - the same
  // convention the chat and read paths use) and are independent - one AdminSettings read, one user
  // read - so run them concurrently rather than paying their sum on this critical path.
  // Each catch WARNS rather than swallowing: a resolved-off gate and a failed lookup produce the same
  // silent "memory just didn't happen" from the outside, and an operator needs to tell a Mongo blip
  // from a legitimate opt-out.
  let v2OptInLookupFailed = false;
  const [adminEnabled, v2OptIn] = await Promise.all([
    adapters.db.adminSettings.getSettingsValue('EnableMementos').catch(err => {
      logger.warn('[Mementos] EnableMementos admin-setting lookup failed; failing closed to V1 off', {
        userId: execution.userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }),
    isMementosV2Enabled(execution.userId).catch(err => {
      v2OptInLookupFailed = true;
      logger.warn('[Mementos] V2 opt-in lookup failed; failing closed to V2 off for this turn', {
        userId: execution.userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }),
  ]);
  return {
    ...resolveMementoGates(execution.enableMementos, Boolean(adminEnabled), v2OptIn),
    v2OptInLookupFailed,
  };
}

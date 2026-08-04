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

import type { IAgentExecution } from '@bike4mind/database';
import type { IAdminSettingsRepository } from '@bike4mind/common';
import { resolveMementoGates, type MementoGates } from '@bike4mind/services';
import { isMementosV2Enabled } from '@server/memory/mementoLedgerMirror';

export type MementoGateExecution = Pick<IAgentExecution, 'userId' | 'enableMementos'>;

export interface MementoGateAdapters {
  db: { adminSettings: Pick<IAdminSettingsRepository, 'getSettingsValue'> };
}

export async function resolveExecutionMementoGates(
  execution: MementoGateExecution,
  adapters: MementoGateAdapters
): Promise<MementoGates> {
  // An explicit per-request opt-out disables both pipelines regardless of the admin setting or the V2
  // opt-in (resolveMementoGates(false, ...) is always { v1: false, v2: false }). It is also the
  // highest-volume input this resolver sees - the Slack senders and the voice proxy all hard-code
  // false - so short-circuiting skips both round trips and keeps the dominant flow off the reads below.
  if (execution.enableMementos === false) return { v1: false, v2: false };

  // Both lookups fail closed to "not enabled" (memory degrades, it never fails the turn - the same
  // convention the chat and read paths use) and are independent - one AdminSettings read, one user
  // read - so run them concurrently rather than paying their sum on this critical path.
  const [adminEnabled, v2OptIn] = await Promise.all([
    adapters.db.adminSettings.getSettingsValue('EnableMementos').catch(() => false),
    isMementosV2Enabled(execution.userId).catch(() => false),
  ]);
  return resolveMementoGates(execution.enableMementos, Boolean(adminEnabled), v2OptIn);
}

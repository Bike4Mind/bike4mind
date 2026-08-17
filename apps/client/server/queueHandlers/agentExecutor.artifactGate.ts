/**
 * Resolves the artifact gate for one agent-executor invocation, and with it the artifact-emission
 * prompt the run receives.
 *
 * The agent surface used to inject the (~2.8k-token) emission prompt off the admin `EnableArtifacts`
 * setting alone, with no channel for caller intent - so a caller that opted out of artifacts still
 * got a system message telling it to emit them, on exactly the runs where no human is reading each
 * turn. This reuses the chat pipeline's `resolveArtifactsEnabled`, so both surfaces answer the
 * question the same way and `undefined` keeps meaning "no preference expressed" rather than "off".
 *
 * Extracted as a pure helper for the same reason `resolveLatticeTools` was: the precedence
 * (start payload, then the persisted doc) is the part a refactor breaks silently. A continuation's
 * SQS payload carries only `executionId` + `connectionId`, so reading the start payload alone would
 * make the gate flip on the second iteration.
 */
import { resolveArtifactsEnabled } from '@bike4mind/services';

export interface ResolveAgentArtifactGateInput {
  /** The admin `EnableArtifacts` setting. `undefined` reads as on - the setting `.prefault`s to true. */
  adminEnableArtifacts?: boolean;
  /** `enableArtifacts` from the WS start payload (present only on new executions). */
  startPayloadEnableArtifacts?: boolean;
  /** `enableArtifacts` persisted on the execution doc (the continuation and dispatched-child fallback). */
  executionEnableArtifacts?: boolean;
}

export function resolveAgentArtifactGate({
  adminEnableArtifacts,
  startPayloadEnableArtifacts,
  executionEnableArtifacts,
}: ResolveAgentArtifactGateInput): boolean {
  return resolveArtifactsEnabled(adminEnableArtifacts ?? true, startPayloadEnableArtifacts ?? executionEnableArtifacts);
}

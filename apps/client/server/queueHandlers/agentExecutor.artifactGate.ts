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
import { ARTIFACT_EMISSION_PROMPT } from '@bike4mind/common';
import { resolveArtifactsEnabled } from '@bike4mind/services';

export interface ResolveAgentArtifactGateInput {
  /**
   * The admin `EnableArtifacts` setting. Only the repository's `boolean | undefined` return type
   * makes absence expressible - the setting `.prefault`s to true and `getSettingsValue` falls back
   * to the same default on a parse failure, so production never passes `undefined`. Read as on.
   */
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

/**
 * The artifact-emission prompt for one invocation, or `undefined` when it must not be injected.
 *
 * Both agent-executor call sites go through here rather than repeating the ternary, because the
 * conditional at the assembly site - not the gate itself - is the part a refactor drops silently.
 * `artifactsEnabled` is the already-resolved `resolveAgentArtifactGate` result: the top-level path
 * needs the same boolean for the DAG bubble-up, so it resolves once and passes it in.
 *
 * `isNewExecution` defaults to true for dispatched children: they are always fresh in-process runs
 * with no checkpoint. A continuation must pass `false` - it already carries the composed system
 * message in `messages[0]`, same as `personaPrompt`.
 *
 * `readPromptSetting` is injected so this stays testable without the settings repository. The
 * `|| ARTIFACT_EMISSION_PROMPT` fallback must resolve to the SAME default as the chat path's
 * `getSettingsValue('ArtifactEmissionPrompt', settings, ARTIFACT_EMISSION_PROMPT)` in
 * `ChatCompletionProcess` - two resolvers, one default.
 */
export async function resolveAgentArtifactEmissionPrompt(args: {
  artifactsEnabled: boolean;
  isNewExecution?: boolean;
  readPromptSetting: () => Promise<string | undefined>;
}): Promise<string | undefined> {
  const { artifactsEnabled, isNewExecution = true, readPromptSetting } = args;
  if (!isNewExecution || !artifactsEnabled) return undefined;
  return (await readPromptSetting()) || ARTIFACT_EMISSION_PROMPT;
}

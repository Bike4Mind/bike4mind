/**
 * Resolves the real Quest id to thread into `ToolContext.questId` for an agent-mode tool call
 * (#1867 turn linkage).
 *
 * The real Quest id is created eagerly at dispatch time (`agentExecute.ts`'s `Quest.create`) and
 * forwarded in the Lambda start payload - but only on the FIRST invocation. A resumed or
 * checkpointed execution has no start payload, so it falls back to `linkedQuestId`, persisted on
 * the `AgentExecution` doc at the same dispatch time specifically so it survives that gap.
 *
 * MUST NEVER read `execution.questId` for this purpose: that field holds `cmd.questId` from the
 * client dispatch, which is actually the sessionId (a back-ref hack) - see its own doc comment on
 * `IAgentExecution`. A naive implementation that mirrors the `sessionId: execution.sessionId`
 * wiring one line above would silently write session ids into every agent-mode
 * `LakeAccessEvent.questId`, indistinguishable from a correct value without knowing this history.
 *
 * Extracted as a pure helper, same reasoning as `resolveLatticeTools` in the sibling
 * `agentExecutor.latticeTools.ts` module: `processExecution` itself has no test harness, so this
 * is what makes the fallback logic unit-testable at all.
 */
export interface ResolveExecutionQuestIdInput {
  /** `questId` from the WS start payload (present only on the first, non-resumed invocation). */
  startPayloadQuestId?: string;
  /** `linkedQuestId` persisted on the execution doc (the resume-path fallback) - NEVER
   * `execution.questId`, which holds the sessionId under a misleading name. */
  executionLinkedQuestId?: string;
}

export function resolveExecutionQuestId({
  startPayloadQuestId,
  executionLinkedQuestId,
}: ResolveExecutionQuestIdInput): string | undefined {
  return startPayloadQuestId ?? executionLinkedQuestId;
}

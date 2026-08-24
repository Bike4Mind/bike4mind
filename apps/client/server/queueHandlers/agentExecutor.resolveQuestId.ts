/**
 * Resolves the real Quest id to thread into `ToolContext.questId` for an agent-mode tool call
 * (#1867 turn linkage).
 *
 * The real Quest id is created eagerly at dispatch time (`agentExecute.ts`'s `Quest.create`) and
 * forwarded in the Lambda start payload - but only on the FIRST invocation. A resumed or
 * checkpointed execution has no start payload, so it falls back to `linkedQuestId`, persisted on
 * the `AgentExecution` doc at the same dispatch time specifically so it survives that gap.
 *
 * MUST NEVER read `execution.questId` for this purpose - not because it is always the wrong value,
 * but because it is not reliably ANY one value: the WS client-dispatch lineage
 * (`agentExecute.handleStart`) stores the sessionId there (a back-ref hack), while the QuestMaster
 * V5 lineage (`runQuestNode.ts`) stores the real Quest id, and children inherit whichever their
 * parent had. See `IAgentExecution.questId`'s own doc comment. A naive implementation that mirrors
 * the `sessionId: execution.sessionId` wiring one line above would silently write session ids into
 * agent-mode `LakeAccessEvent.questId` rows on the WS lineage, indistinguishable from a correct
 * value without knowing this history - and "it's the real id on V5" is exactly the reasoning that
 * would reintroduce it as a well-meant third fallback.
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

/**
 * Deep Agent wake-cycle runtime (app-server layer).
 *
 * Wires the infra-free framework from `@bike4mind/agents` (orchestration loop,
 * ports, ReActAgent act executor) to `@bike4mind/database` (repositories +
 * mappers) and the host's tuned prompts, so the SDK stays Mongo-free. See
 * docs/concepts/deep-agent-framework.md.
 */
// Framework surface - re-exported from the open package for callers that import
// the barrel. The loop, ports, act executor and toolbelt profiles all live in
// @bike4mind/agents now.
export {
  runWakeCycle,
  noopRunAct,
  createReActRunAct,
  agentResultToActResult,
  resolveToolbeltProfile,
  TOOLBELT_PROFILES,
  DEFAULT_TOOLBELT_ROLE,
  buildActQuery,
  buildActSystemPrompt,
  type WakeDeps,
  type ToolMaterializer,
  type ReActRunActConfig,
  type ToolbeltProfile,
  type DeepAgentStore,
  type WakeSteps,
  type WakeOutcome,
  type OrientContext,
  type ActContext,
  type ActResult,
  type ReflectContext,
  type ReflectResult,
  type GroomContext,
} from '@bike4mind/agents';
// Host-private modules: Mongo store, tuned LLM steps + prompts, infra adapters.
export { MongoDeepAgentStore } from './store';
export { LlmWakeSteps, type LlmWakeStepsConfig } from './llmSteps';
export { buildOrientPrompt, buildReflectPrompt, buildGroomPrompt } from './prompts';
export {
  DEFAULT_WAKE_MODEL_ID,
  resolveDeepAgentBackend,
  buildSystemApiKeyTable,
  type ResolvedBackend,
} from './resolveBackend';
export { createDeepAgentToolMaterializer, type DeepAgentToolMaterializerConfig } from './toolMaterializer';
export {
  dispatch as deepAgentWakeDispatch,
  processWake,
  buildDefaultWakeDeps,
  WakePayloadSchema,
  type WakePayload,
} from './wakeHandler';
export {
  enrollDeepAgent,
  enrollDeepAgentWithDefaults,
  type EnrollDeepAgentInput,
  type EnrollDeepAgentDeps,
  type EnrollDeepAgentResult,
} from './enroll';
export {
  runReviewWake,
  createLlmReviewStep,
  buildReviewPrompt,
  type ReviewDeps,
  type ReviewOutcome,
  type ReviewStore,
  type ReviewVerdictStep,
} from './reviewWake';
export {
  enrollMissionForAgent,
  listMissionsForAgent,
  loadLinkedAgentContext,
  type CreateMissionInput,
  type CreateMissionResult,
} from './missions';
export {
  bridgeWakeToSession,
  bridgeReviewToSession,
  formatWakeLogEntry,
  formatReviewLogEntry,
  type MissionBridgeDeps,
} from './missionSessionBridge';

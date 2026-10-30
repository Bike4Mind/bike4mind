/**
 * Deep Agent wake-cycle runtime - the infra-free framework core.
 *
 * Ships the orchestration loop + ports + toolbelt profiles so the open package
 * is a runnable agent runtime. Host apps supply the persistence (`DeepAgentStore`)
 * and cognition (`WakeSteps`) implementations; production-tuned prompts +
 * grooming heuristics live behind a swappable `WakeSteps` impl in the host.
 *
 * See docs/concepts/deep-agent-framework.md.
 */
export * from './types';
export { runWakeCycle, MAX_DRIVE_DELTA_PER_WAKE, type WakeDeps, type WakeLogger } from './wakeCycle';
export { noopRunAct } from './runAct';
export {
  resolveToolbeltProfile,
  registerToolbelts,
  TOOLBELT_PROFILES,
  DEFAULT_TOOLBELT_ROLE,
  type ToolbeltProfile,
} from './toolbelts';
export {
  createAgentExtensionRegistry,
  CONTRIBUTED_GUARD_PRIORITY_MIN,
  CONTRIBUTED_GUARD_PRIORITY_MAX,
  type AgentExtensionContribution,
  type AgentExtensionListing,
  type AgentExtensionLogger,
  type AgentExtensionRegistry,
  type AgentExtensionSource,
  type ResolvedOrchestrationProfile,
  type SurfaceProfileContext,
  type SurfaceProfileEntry,
  type ToolMapGuardContext,
  type ToolMapGuardEntry,
} from './agentExtensions';
export {
  renderCharter,
  renderRecentEpisodes,
  renderHandoff,
  renderActResult,
  buildActSystemPrompt,
  buildActQuery,
} from './prompts';
export {
  createReActRunAct,
  agentResultToActResult,
  applyAgentToolPolicy,
  type ToolMaterializer,
  type ReActRunActConfig,
  type LinkedAgentContext,
} from './reactAct';
export {
  createBackendWakeSteps,
  buildReferenceOrientPrompt,
  buildReferenceReflectPrompt,
  buildReferenceGroomPrompt,
  type BackendWakeStepsConfig,
} from './referenceWakeSteps';

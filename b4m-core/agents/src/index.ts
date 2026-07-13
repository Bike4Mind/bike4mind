/**
 * @bike4mind/agents
 *
 * ReAct (Reasoning and Acting) agent implementation for B4M
 *
 * This package provides a reusable agent that can be used in both
 * the web application and CLI tool.
 */

export { ReActAgent, findIterationBoundary } from './ReActAgent';
export { PERSONA_ALLOWED_SUBAGENTS } from './types';
export { isContextLimitError } from './errors';
export type {
  AgentCheckpoint,
  AgentContext,
  AgentEvents,
  AgentResult,
  AgentRunOptions,
  AgentStep,
  AgentStepType,
  ConfidenceGateDecision,
  ConversationMessage,
  IterationResult,
  ServerAgentConfig,
  ServerAgentDefinition,
  SubagentConfig,
  SubagentContext,
  ThoroughnessLevel,
} from './types';

// Tool parallelizer for parallel execution of independent tools
export {
  categorizeTools,
  executeToolsInParallel,
  getResultsInOrder,
  shouldUseParallelExecution,
  defaultIsReadOnlyTool,
  getToolId,
  DEFAULT_WRITE_TOOLS,
} from './toolParallelizer';
export type { ToolUseInfo, ToolResult, ToolExecutionPlan, IsReadOnlyToolFn } from './toolParallelizer';

// Tool filtering utilities for agent tool access control
export {
  filterToolsByPatterns,
  filterOptInTools,
  selectSubagentTools,
  matchesToolPattern,
  matchesAnyPattern,
  getToolNames,
  isValidToolPattern,
} from './toolFilter';

// DAG task decomposition (shared by CLI in-process executor and web
// Lambda-fan-out executor). Schemas, validators, and the markdown
// result builder live here; per-surface execution loops do not.
export {
  DecomposedTaskSchema,
  DecomposeTaskInputSchema,
  FailurePolicySchema,
  validateAndSort,
  findReadyTasks,
  findCascadeDoomed,
  buildPipelineResult,
} from './dag';
export type {
  DecomposedTask,
  DecomposeTaskInput,
  FailurePolicy,
  PipelineTask,
  PipelineTaskResult,
  PipelineTaskStatus,
  PipelineExecutionResult,
} from './dag';

// Tool name formatting for human-readable display
export { humanizeToolName, toGerund } from './toolFormat';

// -- Deep Agent framework: Quest 1 schemas --
//
// The load-bearing data model for long-horizon autonomous agents:
// Charter (slow-changing identity + groomed memory), Handoff (fast-
// changing per-wake state), Episode (per-wake structured record with
// scope locks), Drives (decaying motivational scalars), and Evidence
// tiers (rigor as an ordered axis). Patterns lifted from a prior
// long-horizon paper-reproduction agent.
//
// See docs/concepts/deep-agent-framework.md for the architecture.
export {
  // Charter
  CharterGoalSchema,
  CharterIdentitySchema,
  CharterSchema,
  DEFAULT_CHARTER_SIZE_BUDGET_BYTES,
  SemanticMemoryEntrySchema,
  SubgoalSchema,
  SubgoalStatusSchema,
  isCharterOverBudget,
  measureCharterSizeBytes,
  // Handoff
  HandoffSchema,
  measureHandoffSizeBytes,
  // Episode
  ActionTakenSchema,
  CharterDiffSchema,
  EpisodeSchema,
  ObservationSchema,
  PolicyDecisionSchema,
  // Drives
  DEFAULT_DRIVES,
  DEFAULT_HALF_LIVES_MS,
  DRIVE_KEYS,
  DriveVectorSchema,
  applyDriveDelta,
  decayDrives,
  summarizeDrives,
  // Evidence tiers
  EVIDENCE_TIER_ORDER,
  EvidenceTierSchema,
  evidenceTierAtLeast,
  evidenceTierRank,
  // Review
  ReviewVerdictSchema,
} from './deepAgent/schemas';
export type {
  Charter,
  CharterGoal,
  CharterIdentity,
  SemanticMemoryEntry,
  Subgoal,
  SubgoalStatus,
  Handoff,
  ActionTaken,
  CharterDiff,
  Episode,
  Observation,
  PolicyDecision,
  DriveKey,
  DriveVector,
  EvidenceTier,
  ReviewVerdict,
} from './deepAgent/schemas';

// -- Deep Agent framework: wake-cycle runtime (infra-free core) --
//
// The orchestration loop (orient -> act -> reflect -> groom) + its ports
// (DeepAgentStore, WakeSteps) + toolbelt profiles. Pure: all I/O goes
// through injected ports, so the loop is unit-testable with fakes and host
// apps supply their own persistence + LLM-backed cognition. The production-
// tuned cognitive prompts + grooming heuristics stay private behind a
// swappable WakeSteps impl in the host application.
export {
  runWakeCycle,
  MAX_DRIVE_DELTA_PER_WAKE,
  noopRunAct,
  resolveToolbeltProfile,
  TOOLBELT_PROFILES,
  DEFAULT_TOOLBELT_ROLE,
  // Framework prompt building blocks (render helpers + act-step prompts). The
  // tuned cognitive prompts (orient/reflect/groom) stay in the host.
  renderCharter,
  renderRecentEpisodes,
  renderHandoff,
  renderActResult,
  buildActSystemPrompt,
  buildActQuery,
  // ReActAgent-backed act executor.
  createReActRunAct,
  agentResultToActResult,
  applyAgentToolPolicy,
  // Reference cognitive steps + default prompts - make the loop runnable with
  // just an ICompletionBackend. Production swaps in a tuned WakeSteps impl.
  createBackendWakeSteps,
  buildReferenceOrientPrompt,
  buildReferenceReflectPrompt,
  buildReferenceGroomPrompt,
} from './deepAgent/runtime';
export type {
  DeepAgentStore,
  WakeSteps,
  WakeDeps,
  WakeLogger,
  WakeOutcome,
  OrientContext,
  ActContext,
  ActResult,
  ReflectContext,
  ReflectResult,
  GroomContext,
  ToolbeltProfile,
  ToolMaterializer,
  ReActRunActConfig,
  LinkedAgentContext,
  BackendWakeStepsConfig,
} from './deepAgent/runtime';

// -- Persistent REPL substrate (RLM pattern) --
//
// The Recursive Language Models pattern (arXiv:2512.24601) lifted into
// the B4M agent SDK. Adds a single capability - `code_execute` as a
// tool - that any ReAct agent can register to gain RLM-style
// orchestration: persistent JS REPL across turns, in-REPL access to
// the agent's other tools, sub-LLM delegation. Domain-specific tool
// descriptors (e.g. data-lake search functions) live with their
// callers; the substrate here is generic.
//
// See apps/client/server/tavern/docs/07-PERSISTENT-REPL-TOOL.md for
// the full architecture spec, BEFORE/MIDDLE/AFTER eval, and roadmap.

// Core: persistent V8 context + per-session lifecycle / budget tracking
export { ReplContext } from './rlm/ReplContext';
export type { ReplToolFn, ReplToolMap, ReplRunResult, ReplContextOptions } from './rlm/ReplContext';
export type { ReplExecutor } from './rlm/replExecutor';
export { WorkerReplExecutor } from './rlm/WorkerReplExecutor';
export type { WorkerReplExecutorOptions } from './rlm/WorkerReplExecutor';
export { IsolatedVmExecutor } from './rlm/IsolatedVmExecutor';
export type { IsolatedVmExecutorOptions } from './rlm/IsolatedVmExecutor';
export {
  ReplSession,
  BudgetExceededError,
  getOrCreateReplSession,
  getReplSession,
  disposeReplSession,
  activeReplSessionCount,
  configureReplSessionRegistry,
  getReplSessionRegistryConfig,
  evictIdleReplSessions,
  _resetReplSessionsForTests,
} from './rlm/ReplSession';
export type { ReplSessionOptions, ReplSessionUsage, ReplSessionEvents } from './rlm/ReplSession';

// Tool factory: wraps a ReplSession in the ICompletionOptionTools contract
export { makeCodeExecuteTool, CODE_EXECUTE_TOOL_NAME } from './rlm/codeExecuteTool';
export type { CodeExecuteToolDeps } from './rlm/codeExecuteTool';

// System prompt: parameterized by the in-REPL tool descriptor list
export { buildReplToolSystemPrompt } from './rlm/prompts';
export type { ReplToolDescriptor, CorpusStats, BuildReplPromptOpts } from './rlm/prompts';

// Bridge: turn ICompletionOptionTools into in-REPL async functions
export { wrapAgentToolsForRepl } from './rlm/wrapAgentToolsForRepl';
export type { WrapOpts, WrapResult } from './rlm/wrapAgentToolsForRepl';

// Production-shape sub-LLM: backed by any ICompletionBackend
export { buildBackendSubAgentQuery } from './rlm/backendSubAgent';
export type { BackendSubAgentDeps } from './rlm/backendSubAgent';

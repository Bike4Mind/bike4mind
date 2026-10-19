import type { PermissionManager } from '../../utils/PermissionManager.js';
import type { PermissionResponse } from '../../components/PermissionPrompt.js';
import type { SandboxOrchestrator } from '../../sandbox/SandboxOrchestrator.js';
import type { ApiClient } from '../../auth/ApiClient.js';
import type { CheckpointStore } from '../../storage/CheckpointStore.js';
import type { InteractionMode } from '../../bootstrap/types.js';

/** The model-supplied arguments of one tool call. */
export type ToolArgs = Record<string, unknown>;

/**
 * What a permission prompt is asking about. 'tool' is a normal tool-call gate;
 * 'directory-grant' is a request to widen the filesystem allow-list, which is a
 * separate decision (deny-by-default in headless, never inheriting the tool's
 * own verdict). Passed as an optional 4th arg so existing 3-arg prompt callbacks
 * remain valid; a headless callback reads it to fail closed on scope widening.
 */
export type PermissionPromptKind = 'tool' | 'directory-grant';

export type ShowPermissionPrompt = (
  toolName: string,
  args: unknown,
  preview?: string
) => Promise<{ action: PermissionResponse }>;

/** The prompt callback as the directory-grant retry calls it, with the prompt kind. */
export type ShowKindedPermissionPrompt = (
  toolName: string,
  args: unknown,
  preview?: string,
  kind?: PermissionPromptKind
) => Promise<{ action: PermissionResponse }>;

/**
 * Per-agent state the tool wrappers share with their entry point.
 */
export type AgentContext = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  currentAgent: any | null; // ReActAgent instance
  /** Called (synchronously, must not block) after a file-writing tool succeeds, with the path as the tool received it. */
  onFileChanged?: (filePath: string) => void;
};

/**
 * Collaborators the permission gateway needs. Bundled so every entrypoint that builds a tool
 * list (B4M, MCP, CLI-built and delegation tools) routes it through the ONE gateway. The tool
 * catalog is read through `permissionManager.catalog`, so the permission check and every
 * descriptor-driven stage resolve a name against the same catalog.
 */
export type WrapToolDeps = {
  permissionManager: PermissionManager;
  showPermissionPrompt: ShowPermissionPrompt;
  agentContext: AgentContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configStore: any; // ConfigStore instance (no shared interface)
  apiClient: ApiClient;
  sandboxOrchestrator?: SandboxOrchestrator;
  /** Live, mutable allow-list shared with the core tool context. The path access-grant flow
   *  pushes onto it in place, so a grant takes effect on the next call without rebuilding tools. */
  allowedDirectories?: string[];
  /** Ceiling interaction mode for a spawned subagent. When set, the tool runs at the
   *  less-permissive of this and the live store mode, so a subagent can never exceed
   *  its parent's authority yet still tightens if the user switches to plan mode
   *  mid-run. Undefined for the main agent (uses the live store mode). */
  interactionModeOverride?: InteractionMode;
  /** Snapshots a file before an approved write so /undo can restore it. */
  checkpointStore?: CheckpointStore | null;
};

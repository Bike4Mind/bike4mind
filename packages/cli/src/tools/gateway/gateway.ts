import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { ToolArgs, WrapToolDeps } from './gatewayTypes.js';
import { prepareSandbox, cleanupSandboxFiles } from './stages/sandbox.js';
import { resolveInteractionMode, planModeRefusal } from './stages/planMode.js';
import { assessCommandRisk } from './stages/commandRisk.js';
import { bindEditPlan, isFuzzyEditPlan, resolveFuzzyEditGate } from './stages/fuzzyEdit.js';
import { applyPromptResponse, canRunWithoutPrompt, promptSessionScope } from './stages/permissionDecision.js';
import { commandTextOf } from './toolPolicy.js';
import { buildPromptPreview } from './stages/preview.js';
import { executeAndRecord } from './stages/execution.js';

/**
 * The args handed to execution, minus any gateSnapshot or confirmedFuzzyHash. Only the
 * edit_local_file gate (once it actually resolves) may set these fields, plus
 * executeWithFuzzyConfirmation for confirmedFuzzyHash. Stripping them unconditionally, rather
 * than only when the gate resolves, closes the path where an externally supplied gateSnapshot
 * would survive whenever resolveEditLocalFile() throws (an ambiguous or no-match old_string,
 * not just an auth/IO error) and let editLocalFile() trust an unverified span.
 * confirmedFuzzyHash also survives an exact-match gate (no fuzzy prompt), so a model-supplied
 * hash could pre-confirm a fuzzy edit the file drifted into.
 */
export function stripGateFields(args: ToolArgs | undefined): ToolArgs {
  const {
    gateSnapshot: _modelSuppliedGateSnapshot,
    confirmedFuzzyHash: _modelSuppliedFuzzyHash,
    ...argsSansGateFields
  } = args ?? {};
  return argsSansGateFields;
}

/**
 * Wrap a tool with the gateway. Stages, in order: the shell sandbox; the plan-mode, command-risk,
 * fuzzy-edit and permission gates; a checkpoint before an approved file write (stages/checkpoint);
 * execution with server routing, where every run's output is redacted and then capped
 * (stages/output) before the sandbox-escalation and path-grant retries look at it. Every policy
 * question about the tool is answered from its descriptor in the permission manager's catalog,
 * resolved per call.
 */
export function wrapToolWithPermission(tool: ICompletionOptionTools, deps: WrapToolDeps): ICompletionOptionTools {
  const { permissionManager, showPermissionPrompt, allowedDirectories } = deps;
  const originalFn = tool.toolFn;
  const toolName = tool.toolSchema.name;
  const isMcpTool = tool._isMcpTool === true;

  return {
    ...tool,
    toolFn: async (input?: unknown) => {
      // The model's tool-call arguments: a JSON object, or absent.
      const args = input as ToolArgs | undefined;
      const descriptor = permissionManager.catalog.resolve(toolName);

      const sandbox = prepareSandbox(descriptor, args, deps.sandboxOrchestrator, allowedDirectories);
      if (sandbox.kind === 'blocked') return sandbox.message;
      const isSandboxed = sandbox.kind === 'sandboxed';
      const effectiveArgs = isSandboxed ? sandbox.args : args;
      let execArgs = stripGateFields(effectiveArgs);
      // Temp sandbox profile this wrapper created (Seatbelt writes a .sb file). Cleaned once in
      // the finally below: after the awaited command completes on the success path, and on any
      // early-return path (plan-mode block, permission deny) that skips executeAndRecord. The
      // success-path returns MUST `await` executeAndRecord() - a bare `return <promise>` inside
      // try/finally runs the finally synchronously at the return, rmSync'ing this profile before
      // the spawned sandbox-exec ever opens it (every sandboxed command would then fail). The
      // paths come only from the prepareSandbox result, never from the call's args.
      const sandboxCleanupPaths = isSandboxed ? sandbox.cleanupPaths : undefined;

      const run = () =>
        executeAndRecord({
          toolName,
          descriptor,
          rawArgs: args,
          execArgs,
          isSandboxed,
          originalFn,
          apiClient: deps.apiClient,
          showPermissionPrompt,
          permissionManager,
          agentContext: deps.agentContext,
          configStore: deps.configStore,
          sandboxOrchestrator: deps.sandboxOrchestrator,
          allowedDirectories,
          checkpointStore: deps.checkpointStore,
        });

      try {
        const interactionMode = await resolveInteractionMode(deps.interactionModeOverride);
        const refusal = planModeRefusal(toolName, descriptor, args, interactionMode);
        if (refusal) return refusal;

        const commandRisk = assessCommandRisk(descriptor, args);
        const forcePromptForRisk = commandRisk?.level === 'high';
        const editPlan = await resolveFuzzyEditGate(toolName, args, allowedDirectories);
        const forcePromptForFuzzyEdit = isFuzzyEditPlan(editPlan);
        const forcePrompt = forcePromptForRisk || forcePromptForFuzzyEdit;
        execArgs = bindEditPlan(toolName, execArgs, effectiveArgs, editPlan);

        const command = commandTextOf(descriptor, args);
        if (
          canRunWithoutPrompt({
            toolName,
            isMcpTool,
            forcePrompt,
            isSandboxed,
            command,
            interactionMode,
            permissionManager,
          })
        ) {
          return await run();
        }

        const preview = await buildPromptPreview({
          toolName,
          args,
          isSandboxed,
          allowedDirectories,
          editPlan,
          forcingRisk: forcePromptForRisk ? commandRisk : null,
        });
        const sessionScope = promptSessionScope(toolName, args, permissionManager);
        // Waits indefinitely for the user's answer.
        const response = await showPermissionPrompt(toolName, effectiveArgs, preview, undefined, { sessionScope });
        await applyPromptResponse(toolName, args, response.action, permissionManager, deps.configStore);
        return await run();
      } finally {
        cleanupSandboxFiles(sandboxCleanupPaths);
      }
    },
  };
}

/**
 * Route a set of otherwise-raw tools through the gateway. This is the single choke-point every
 * tool the model can call must pass through; anything constructed outside generateCliTools is
 * wrapped here before it reaches the agent.
 */
export function wrapTools(tools: ICompletionOptionTools[], deps: WrapToolDeps): ICompletionOptionTools[] {
  return tools.map(tool => wrapToolWithPermission(tool, deps));
}

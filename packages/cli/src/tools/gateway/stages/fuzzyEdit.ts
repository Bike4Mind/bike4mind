import { PermissionDeniedError } from '@bike4mind/common';
import {
  resolveEditLocalFile,
  isFuzzyEditConfirmationRequired,
  type EditPlan,
} from '@bike4mind/services/llm/tools/cliTools';
import { executeTool } from '../../../llm/ToolRouter.js';
import type { ApiClient } from '../../../auth/ApiClient.js';
import type { ShowPermissionPrompt, ToolArgs } from '../gatewayTypes.js';

/**
 * Fuzzy-edit gate: resolve an edit_local_file edit ONCE, through the SAME path authorization
 * the tool itself enforces (no raw model-supplied path is ever read here), to learn whether it
 * resolves via the fuzzy fallback - which can write a wider span than old_string names. Such an
 * edit is re-confirmed even under trust / auto-accept so the human sees the real span. Any
 * resolve error (auth denial, missing file, no match) yields null: the gate forces no prompt
 * and the real error surfaces at execution. edit_local_file is never shell-like, so this and
 * the command-risk gate never both force a prompt.
 */
export async function resolveFuzzyEditGate(
  toolName: string,
  args: ToolArgs | undefined,
  allowedDirectories: string[] | undefined
): Promise<EditPlan | null> {
  if (
    toolName !== 'edit_local_file' ||
    typeof args?.path !== 'string' ||
    typeof args?.old_string !== 'string' ||
    typeof args?.new_string !== 'string'
  ) {
    return null;
  }
  try {
    return await resolveEditLocalFile(
      args as { path: string; old_string: string; new_string: string },
      allowedDirectories
    );
  } catch {
    return null;
  }
}

/** Whether the gate's edit plan resolved via the fuzzy fallback and must be re-confirmed. */
export function isFuzzyEditPlan(editPlan: EditPlan | null): boolean {
  return editPlan?.strategy != null;
}

/**
 * Bind execution to the gate's edit plan. A fuzzy edit is bound to the snapshot the gate just
 * approved, so the bytes written are the ones the human confirmed: the tool refuses a fuzzy edit
 * whose content-hash no longer matches, forcing a fresh prompt (see executeWithFuzzyConfirmation).
 * Exact edits are deterministic and need no binding. Any resolved edit also hands the write path
 * the gate's span, so it can skip its own resolveEdit() pass when the file still hashes to what
 * the gate saw; the write path still always reads the file fresh, since it can change between
 * the gate and the write with no permission prompt involved (another tool call, a formatter).
 */
export function bindEditPlan(
  toolName: string,
  execArgs: ToolArgs,
  effectiveArgs: ToolArgs | undefined,
  editPlan: EditPlan | null
): ToolArgs {
  if (!editPlan) return execArgs;
  let bound = execArgs;
  if (isFuzzyEditPlan(editPlan)) {
    bound = { ...effectiveArgs, confirmedFuzzyHash: editPlan.contentHash };
  }
  if (toolName === 'edit_local_file') {
    bound = {
      ...bound,
      gateSnapshot: { contentHash: editPlan.contentHash, resolvedEdit: editPlan.resolvedEdit },
    };
  }
  return bound;
}

/**
 * Prepend a banner to an edit_local_file preview whose old_string was not an
 * exact match. The diff passed in is the resolved fuzzy span (from the tool's own
 * authorized resolve), so the banner just explains why this edit is re-prompted
 * despite trust / auto-accept.
 */
export function prependFuzzyEditBanner(basePreview: string | undefined): string {
  const banner = '[!] old_string was not an exact match; the diff below is the actual span that will be written.';
  return basePreview ? `${banner}\n\n${basePreview}` : banner;
}

/**
 * Execute a tool, and when the core edit_local_file tool refuses a fuzzy edit that
 * is not bound to the current file snapshot - the gate saw an exact match but the
 * file changed before the write, or a directory grant re-entered here - force ONE
 * permission prompt showing the REAL resolved span, then retry bound to the hash
 * the tool reported so the write matches what the human approved. A further
 * concurrent change makes the tool refuse again; that is surfaced rather than
 * looped - fail safe, never a silent wider-than-named write.
 */
export async function executeWithFuzzyConfirmation(
  toolName: string,
  args: ToolArgs,
  apiClient: ApiClient,
  originalFn: (args: unknown) => Promise<string>,
  showPermissionPrompt: ShowPermissionPrompt
): Promise<string> {
  try {
    return await executeTool(toolName, args, apiClient, originalFn);
  } catch (err) {
    if (!isFuzzyEditConfirmationRequired(err)) throw err;
    const response = await showPermissionPrompt(toolName, args, prependFuzzyEditBanner(err.diffPreview));
    if (response.action === 'deny') throw new PermissionDeniedError(toolName, args);
    return executeTool(toolName, { ...args, confirmedFuzzyHash: err.contentHash }, apiClient, originalFn);
  }
}

import { isPathAllowed, type EditPlan } from '@bike4mind/services/llm/tools/cliTools';
import {
  generateFileDiffPreview,
  generateFileDeletePreview,
  generateEditLocalFilePreview,
} from '../../../utils/diffPreview.js';
import type { ToolArgs } from '../gatewayTypes.js';
import { prependRiskBanner, type CommandRisk } from './commandRisk.js';
import { isFuzzyEditPlan, prependFuzzyEditBanner } from './fuzzyEdit.js';

export type PromptPreviewInput = {
  toolName: string;
  args: ToolArgs | undefined;
  isSandboxed: boolean;
  allowedDirectories: string[] | undefined;
  editPlan: EditPlan | null;
  /** Set only when the command-risk gate forced this prompt. */
  forcingRisk: CommandRisk | null;
};

/**
 * The preview shown in the permission prompt. For edit_local_file the gate already resolved
 * the real span through the authorized preflight, so reuse that (one resolve, no extra raw-path
 * read); fall back to the generic preview only when the edit did not resolve. A forced prompt
 * carries the banner explaining why it was forced.
 */
export async function buildPromptPreview(input: PromptPreviewInput): Promise<string | undefined> {
  const { toolName, args, isSandboxed, allowedDirectories, editPlan, forcingRisk } = input;
  const basePreview =
    toolName === 'edit_local_file' && editPlan
      ? editPlan.diffPreview
      : await generateToolPreview(toolName, args ?? {}, isSandboxed, allowedDirectories);
  if (forcingRisk) return prependRiskBanner(basePreview, forcingRisk.reasons);
  if (isFuzzyEditPlan(editPlan)) return prependFuzzyEditBanner(basePreview);
  return basePreview;
}

/**
 * Generate a human-readable preview string for a tool invocation.
 * Used in the permission prompt to show what the tool will do.
 */
async function generateToolPreview(
  toolName: string,
  args: ToolArgs,
  isSandboxed: boolean,
  allowedDirectories?: string[]
): Promise<string | undefined> {
  try {
    // Any preview that reads a file must go through the SAME authorization as
    // execution: never open a raw model-supplied path the tool would itself
    // reject. Without this, previewing an out-of-bounds path reads it anyway, and
    // a special file such as /dev/zero hangs or exhausts memory in the preflight
    // rather than failing at the allowlist.
    const pathArg = typeof args?.path === 'string' ? (args.path as string) : undefined;
    const readsFile = toolName === 'edit_local_file' || toolName === 'create_file' || toolName === 'delete_file';
    if (readsFile && pathArg && !isPathAllowed(pathArg, allowedDirectories).allowed) {
      return `[Path outside allowed directories: ${pathArg}]`;
    }

    if (toolName === 'edit_local_file' && args?.path && args?.old_string && typeof args?.new_string === 'string') {
      return await generateEditLocalFilePreview({
        path: args.path as string,
        old_string: args.old_string as string,
        new_string: args.new_string,
      });
    }

    if (toolName === 'create_file' && args?.path && args?.content) {
      return await generateFileDiffPreview({
        path: args.path as string,
        content: args.content as string,
      });
    }

    if (toolName === 'delete_file' && args?.path) {
      return await generateFileDeletePreview({
        path: args.path as string,
      });
    }

    if (toolName === 'bash_execute' && args?.command) {
      const cwd = args.cwd ? ` (in ${args.cwd})` : '';
      const timeout = args.timeout ? ` [timeout: ${args.timeout}ms]` : '';
      const sandboxLabel = isSandboxed ? ' [sandboxed]' : '';
      return `$ ${args.command}${cwd}${timeout}${sandboxLabel}`;
    }
  } catch (error) {
    return `[Could not generate preview: ${error instanceof Error ? error.message : 'Unknown error'}]`;
  }

  return undefined;
}

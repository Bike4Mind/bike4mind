/**
 * CLI-only tool loader - isolated from tools/index.ts to prevent Turbopack
 * from tracing into tool implementations that use dynamic path.resolve() calls.
 *
 * Turbopack follows both static and dynamic import() expressions when building
 * the dependency graph. By keeping these imports in a separate file that the
 * web app never touches, we break the trace chain entirely.
 *
 * Import chain that MUST NOT exist:
 *   opti.ts -> ChatCompletionProcess -> tools/index -> [CLI tools]
 *
 * Instead, CLI consumers import directly:
 *   toolsAdapter.ts -> tools/cliTools -> [CLI tools]
 */
import type { ToolDefinition } from './base/types';
import type { CliLlmTools } from './index';

// Static imports - these modules do NOT use dynamic path.resolve(process.cwd(), ...)
// and are safe from Turbopack's broad file pattern tracing.
import { fileReadTool } from './implementation/fileRead';
import { editLocalFileTool } from './implementation/editLocalFile';
import { recentChangesTool } from './implementation/recentChanges';
import { askUserQuestionTool } from './implementation/askUserQuestion';
import {
  checkShellOutputTool,
  writeShellStdinTool,
  listBackgroundShellsTool,
  killBackgroundShellTool,
} from './implementation/shellSession';
import {
  latticeCreateModelTool,
  latticeAddEntityTool,
  latticeSetValueTool,
  latticeCreateRuleTool,
  latticeQueryTool,
  latticeExplainTool,
} from './implementation/lattice';

// Re-export the shell-session manager through this CLI-only entry so the CLI can
// subscribe to / reap the SAME singleton the tools use, without a deep import.
export {
  getShellSessionManager,
  type ShellSession,
  type ShellSessionStatus,
} from './implementation/bashExecute/ShellSessionManager';

/**
 * The 6 Lattice tool implementations as a resolvable map keyed by tool name.
 * `buildSharedTools`/`generateTools` only resolve names present in their
 * definition map (`b4mTools`), and Lattice is deliberately excluded from it -
 * so any consumer that enables Lattice (quest processor, agent executor) must
 * supply these definitions explicitly (e.g. as `externalTools`) for the names
 * in `LATTICE_TOOL_NAMES` to actually resolve.
 *
 * All entries are static imports (no dynamic `path.resolve`), so referencing
 * this map does NOT trigger the broad Turbopack file tracing that the lazily
 * `import()`-ed bash/file tools below would - it is safe for server Lambdas to
 * import even though the web app must not.
 */
export const latticeToolDefinitions = {
  lattice_create_model: latticeCreateModelTool,
  lattice_add_entity: latticeAddEntityTool,
  lattice_set_value: latticeSetValueTool,
  lattice_create_rule: latticeCreateRuleTool,
  lattice_query: latticeQueryTool,
  lattice_explain: latticeExplainTool,
} satisfies Record<string, ToolDefinition>;

/**
 * Lazily loads CLI-only tools. The 5 tools loaded via dynamic import()
 * (bashExecute, createFile, deleteFile, globFiles, grepSearch) use
 * path.resolve(process.cwd(), ...) which causes Turbopack to trace 11k+ files.
 * All other tools are statically imported above - they don't trigger tracing.
 */
export const getCliOnlyTools = async (): Promise<{
  [key in CliLlmTools]: ToolDefinition;
}> => {
  const [{ createFileTool }, { globFilesTool }, { grepSearchTool }, { deleteFileTool }, { bashExecuteTool }] =
    await Promise.all([
      import('./implementation/createFile'),
      import('./implementation/globFiles'),
      import('./implementation/grepSearch'),
      import('./implementation/deleteFile'),
      import('./implementation/bashExecute'),
    ]);

  return {
    // File operation tools
    file_read: fileReadTool,
    create_file: createFileTool,
    edit_local_file: editLocalFileTool,
    glob_files: globFilesTool,
    grep_search: grepSearchTool,
    delete_file: deleteFileTool,
    // Shell execution
    bash_execute: bashExecuteTool,
    // Background shell sessions (poll/stdin/list/kill for backgrounded bash_execute)
    check_shell_output: checkShellOutputTool,
    write_shell_stdin: writeShellStdinTool,
    list_background_shells: listBackgroundShellsTool,
    kill_background_shell: killBackgroundShellTool,
    // Git operations
    recent_changes: recentChangesTool,

    // Lattice financial modeling tools
    ...latticeToolDefinitions,
    // Interactive tools
    ask_user_question: askUserQuestionTool,
  };
};

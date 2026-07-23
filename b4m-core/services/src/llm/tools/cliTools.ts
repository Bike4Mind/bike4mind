/**
 * CLI tool surface - the single entry point CLI consumers import so their bundle
 * never reaches the full `tools/index.ts` graph.
 *
 * Two boundaries converge here:
 *
 * 1. Turbopack: `tools/index.ts` transitively imports tool implementations that
 *    use dynamic `path.resolve(process.cwd(), ...)`, which makes Turbopack trace
 *    11k+ files. Keeping the CLI's tools in a file the web app never imports for
 *    that purpose breaks the trace chain.
 *
 * 2. CLI bundle externals (issue #660): `tools/index.ts` also statically imports
 *    server-only tools (image generation -> jimp/@aws-sdk/client-rekognition,
 *    excel export -> write-excel-file) the CLI never runs. Importing anything
 *    from `tools/index.ts` drags those + their heavy npm deps into the CLI
 *    bundle. This module exposes exactly the surface the CLI needs - the CLI-only
 *    tools, the small subset of shared tools it enables, and the pure
 *    tool/MCP generators - so the CLI can drop the `@bike4mind/services` barrel
 *    entirely and the build's externals guard stays green.
 *
 * Import chain that MUST NOT exist:
 *   opti.ts -> ChatCompletionProcess -> tools/index -> [CLI tools]
 *
 * Instead, CLI consumers import directly:
 *   toolsAdapter.ts / mcpAdapter.ts -> tools/cliTools -> [CLI-safe surface]
 */
import type { ToolDefinition } from './base/types';
import type { CliLlmTools, LlmTools } from './index';

// Static imports - these modules do NOT use dynamic path.resolve(process.cwd(), ...)
// and are safe from Turbopack's broad file pattern tracing.
import { fileReadTool } from './implementation/fileRead';
import { editLocalFileTool } from './implementation/editLocalFile';
import { recentChangesTool } from './implementation/recentChanges';
import { askUserQuestionTool } from './implementation/askUserQuestion';

// Shared b4mTools the CLI enables. Imported individually (not via `b4mTools` from
// tools/index) so the CLI never statically reaches the server-only image/excel
// tools that live alongside them in that map. See issue #660.
import { diceRollTool } from './implementation/diceroll';
import { mathTool } from './implementation/math';
import { currentDateTimeTool } from './implementation/currentDateTime';
import { promptEnhancementTool } from './implementation/promptEnhancement';
import { weatherTool } from './implementation/weather';
import { webSearchTool } from './implementation/websearch';
import { webFetchTool } from './implementation/webfetch';
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

// Pure tool/MCP generators - free of any tool-implementation imports - re-exported
// so the CLI gets them without touching tools/index. See toolGenerators.ts.
export { generateTools, generateMcpTools, generateMcpToolsFromCache } from './toolGenerators';

// The ask_user_question callback setter and its payload types, so the CLI's
// interactive prompt can be wired in without importing the barrel.
export { setShowUserQuestionFn } from './implementation/askUserQuestion';
export type { UserQuestionPayload, UserQuestionResponse } from './implementation/askUserQuestion';
export type { LlmTools } from './index';

/**
 * The subset of shared `b4mTools` the CLI enables. Exposed as a map so the CLI
 * builds its tool set from a services-owned boundary instead of filtering the
 * full `b4mTools` (which would drag the server-only image/excel tools into its
 * bundle). Keep in sync with the CLI's enabled-tools policy in toolsAdapter.ts.
 */
export const cliSharedTools = {
  dice_roll: diceRollTool,
  math_evaluate: mathTool,
  current_datetime: currentDateTimeTool,
  prompt_enhancement: promptEnhancementTool,
  weather_info: weatherTool,
  web_search: webSearchTool,
  web_fetch: webFetchTool,
} satisfies Partial<Record<LlmTools, ToolDefinition>>;

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

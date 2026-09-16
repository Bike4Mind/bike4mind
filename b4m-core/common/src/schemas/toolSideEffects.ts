import type { B4MLLMTools } from './llm';

/**
 * How much of the world a tool disturbs when it runs. This is the input the agent-mode
 * permission gate classifies on (see apps/client/server/queueHandlers/agentExecutorUtils/
 * toolPermissions.ts); it is deliberately about blast radius, not about usefulness.
 *
 * - `none`     Reads only. Returns a computation or a public/read-only lookup. Nothing the
 *              user owns is written, nothing leaves on their behalf.
 * - `local`    Writes only in-conversation output the user can see and undo - an <artifact>
 *              block, a navigation suggestion, an /opti-gated __uiSideEffect. No storage
 *              write, no user-data mutation, no outbound call on the user's behalf.
 * - `external` Everything else: mutates stored user data, writes to generated-content
 *              storage, posts somewhere, or spawns another agent.
 *
 * Same-risk tools must be classified alike, or agent mode auto-runs one while pausing its
 * twin for approval. The OptiHashi group is the live example: all five share one surface and
 * one autonomous loop (decompose -> formulate -> schedule -> advance), so splitting them
 * would interrupt that loop at every step.
 *
 * WHY THIS LIVES IN `common` AND NOT ON `ToolDefinition`: the natural home for the
 * declaration is the tool descriptor at its implementation site, but every consumer of a
 * value from `services/llm/tools/index` drags the whole tool graph - jimp,
 * @aws-sdk/client-rekognition, write-excel-file - into its bundle (see the header of
 * `toolGenerators.ts` and issue #660). The permission gate must stay cheap to import. The
 * `Record<B4MLLMTools, ...>` annotation below is what replaces the descriptor field: adding
 * a name to `b4mLLMTools` without classifying it is a compile error, so a new tool can no
 * longer become an approval prompt by omission.
 */
export type ToolSideEffects = 'none' | 'local' | 'external';

/**
 * Every tool name in `b4mLLMTools`. Exhaustive by annotation - do not widen the type.
 */
const CORE_TOOL_SIDE_EFFECTS: Record<B4MLLMTools, ToolSideEffects> = {
  dice_roll: 'none',
  weather_info: 'none',
  web_search: 'none',
  web_fetch: 'none',
  wolfram_alpha: 'none',
  // Spends credits on its own nested LLM calls but writes nothing and acts on nobody's
  // behalf; it has run unprompted since agent mode shipped and is classified to match.
  deep_research: 'none',
  math_evaluate: 'none',
  current_datetime: 'none',
  prompt_enhancement: 'none',
  wikipedia_on_this_day: 'none',
  moon_phase: 'none',
  sunrise_sunset: 'none',
  iss_tracker: 'none',
  planet_visibility: 'none',
  search_knowledge_base: 'none',
  retrieve_knowledge_content: 'none',
  count_knowledge_base: 'none',
  chess_engine: 'none',
  fmp_financial_data: 'none',
  bob_panel_read: 'none',
  // Expands a stored instruction template into text for the next turn; writes nothing.
  skill: 'none',

  // Emit an <artifact> block or a UI suggestion and nothing else.
  recharts: 'local',
  mermaid_chart: 'local',
  navigate_view: 'local',
  // Serializes a .ipynb into the observation; unlike excel_generation it does not persist
  // the file, so it stops at `local`.
  generate_jupyter_notebook: 'local',
  optihashi_schedule: 'local',
  optihashi_formulate: 'local',
  optihashi_edit_problem: 'local',

  image_generation: 'external',
  edit_image: 'external',
  music_generation: 'external',
  audio_generation: 'external',
  excel_generation: 'external',
  edit_file: 'external',
  blog_publish: 'external',
  blog_edit: 'external',
  blog_draft: 'external',
  delegate_to_agent: 'external',
};

/**
 * Tool names that reach the pipeline from outside `b4mLLMTools` - the CLI tool set, the
 * Slack tool set, and premium-overlay tools supplied at runtime via the `externalTools`
 * merge. No enum to key off, so these get no compile-time exhaustiveness; an unlisted name
 * falls through to the gated default, which is the correct failure direction.
 */
const EXTERNAL_REGISTRY_SIDE_EFFECTS: Record<string, ToolSideEffects> = {
  // CLI reads
  file_read: 'none',
  glob_files: 'none',
  grep_search: 'none',
  recent_changes: 'none',
  check_shell_output: 'none',
  list_background_shells: 'none',
  lattice_query: 'none',
  lattice_explain: 'none',
  ask_user_question: 'local',

  // CLI writes
  create_file: 'external',
  edit_local_file: 'external',
  delete_file: 'external',
  bash_execute: 'external',
  write_shell_stdin: 'external',
  kill_background_shell: 'external',
  lattice_create_model: 'external',
  lattice_add_entity: 'external',
  lattice_set_value: 'external',
  lattice_create_rule: 'external',

  // Slack tool set
  slackbot_help: 'none',
  list_curated_files: 'none',
  notebook_status: 'none',
  share_curated_file: 'external',
  notebook_new: 'external',
  confirm_pending_action: 'external',
  cancel_pending_action: 'external',

  // Premium overlay
  mission_status: 'none',
  optihashi_decompose: 'local',
  optihashi_solve: 'local',
  send_slack_message: 'external',
  coordinate_task: 'external',
  code_execute: 'external',
  video_generation: 'external',
};

const TOOL_SIDE_EFFECTS: Readonly<Record<string, ToolSideEffects>> = {
  ...CORE_TOOL_SIDE_EFFECTS,
  ...EXTERNAL_REGISTRY_SIDE_EFFECTS,
};

/**
 * The declared blast radius of `toolName`, or `undefined` when nothing declares one -
 * an MCP tool, a premium-overlay tool nobody classified, a name from a registry this
 * module has never heard of. Callers treat `undefined` as "assume the worst".
 */
export function getToolSideEffects(toolName: string): ToolSideEffects | undefined {
  return TOOL_SIDE_EFFECTS[toolName];
}

/** Test/introspection accessor. Prefer `getToolSideEffects` for lookups. */
export function listDeclaredToolSideEffects(): Readonly<Record<string, ToolSideEffects>> {
  return TOOL_SIDE_EFFECTS;
}

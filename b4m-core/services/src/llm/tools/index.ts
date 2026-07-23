import { ToolDefinition } from './base/types';
export type { ToolContext, ToolDefinition } from './base/types';
import { diceRollTool } from './implementation/diceroll';
import { weatherTool } from './implementation/weather';
import { imageGenerationTool } from './implementation/imageGeneration';
import { webSearchTool } from './implementation/websearch';
import { webFetchTool } from './implementation/webfetch';
import { wolframAlphaTool } from './implementation/wolfram_alpha';
import { mathTool } from './implementation/math';
import { mermaidChartTool } from './implementation/mermaidChart';
import { currentDateTimeTool } from './implementation/currentDateTime';
import { deepResearchTool } from './implementation/deepResearch';
import { B4MLLMTools, PremiumOverlayToolName } from '@bike4mind/common';
import { promptEnhancementTool } from './implementation/promptEnhancement';
import { rechartsTool } from './implementation/recharts';
import { editFileTool } from './implementation/editFile';
import { imageEditTool } from './implementation/imageEdit';
import { blogPublishTool } from './implementation/blogPublish';
import { blogEditTool } from './implementation/blogEdit';
import { blogDraftTool } from './implementation/blogDraft';
import { wikipediaOnThisDayTool } from './implementation/wikipediaOnThisDay';
import { moonPhaseTool } from './implementation/moonPhase';
import { sunriseSunsetTool } from './implementation/sunriseSunset';
import { issTrackerTool } from './implementation/issTracker';
import { planetVisibilityTool } from './implementation/planetVisibility';
import { knowledgeBaseSearchTool } from './implementation/knowledgeBaseSearch';
import { knowledgeBaseRetrieveTool } from './implementation/knowledgeBaseRetrieve';
import { navigateViewTool } from './implementation/navigateView';
import { jupyterNotebookTool } from './implementation/jupyterNotebook';
import { excelGenerationTool } from './implementation/excelGeneration';
import { fmpTool } from './implementation/fmp';
import { skillTool } from './implementation/skill';
import { chessEngineTool } from './implementation/chessEngine';
import { setShowUserQuestionFn } from './implementation/askUserQuestion';

export type LlmTools = B4MLLMTools;
export type CliLlmTools =
  | 'file_read'
  | 'create_file'
  | 'edit_local_file'
  | 'glob_files'
  | 'grep_search'
  | 'delete_file'
  | 'bash_execute'
  | 'check_shell_output'
  | 'write_shell_stdin'
  | 'list_background_shells'
  | 'kill_background_shell'
  | 'recent_changes'
  | 'lattice_create_model'
  | 'lattice_add_entity'
  | 'lattice_set_value'
  | 'lattice_create_rule'
  | 'lattice_query'
  | 'lattice_explain'
  | 'ask_user_question';
export type SlackLlmTools =
  | 'slackbot_help'
  | 'list_curated_files'
  | 'share_curated_file'
  | 'notebook_new'
  | 'notebook_status'
  | 'confirm_pending_action'
  | 'cancel_pending_action';
export { setShowUserQuestionFn };
export type {
  UserQuestionPayload,
  UserQuestionResponse,
  UserQuestion,
  QuestionOption,
  UserQuestionAnswer,
} from './implementation/askUserQuestion';

export type { Searcher, SearchResult, ContentExtractionResult } from './implementation/deepResearch';

/**
 * Canonical list of Lattice tool names. Lattice (financial pro-forma modeling)
 * is gated behind the `enableLattice` feature flag; when enabled, callers append
 * these to their `enabledTools` so the LLM can offload structured data into a
 * queryable model instead of carrying it in the context window.
 *
 * Names only - no implementations - so this stays web-safe. `tools/index` is
 * imported broadly by the Next app; the resolvable implementations live in the
 * CLI-isolated `cliTools` module (`latticeToolDefinitions`) to avoid dragging
 * Turbopack into the tool implementations (see `cliTools.ts` header).
 */
export const LATTICE_TOOL_NAMES = [
  'lattice_create_model',
  'lattice_add_entity',
  'lattice_set_value',
  'lattice_create_rule',
  'lattice_query',
  'lattice_explain',
] as const satisfies readonly CliLlmTools[];

export const b4mTools = {
  dice_roll: diceRollTool,
  weather_info: weatherTool,
  image_generation: imageGenerationTool,
  edit_image: imageEditTool,
  web_search: webSearchTool,
  web_fetch: webFetchTool,
  wolfram_alpha: wolframAlphaTool,
  math_evaluate: mathTool,
  mermaid_chart: mermaidChartTool,
  current_datetime: currentDateTimeTool,
  deep_research: deepResearchTool,
  prompt_enhancement: promptEnhancementTool,
  recharts: rechartsTool,
  edit_file: editFileTool,
  blog_publish: blogPublishTool,
  blog_edit: blogEditTool,
  blog_draft: blogDraftTool,
  // Time Machine & Night Sky tools
  wikipedia_on_this_day: wikipediaOnThisDayTool,
  moon_phase: moonPhaseTool,
  sunrise_sunset: sunriseSunsetTool,
  iss_tracker: issTrackerTool,
  planet_visibility: planetVisibilityTool,

  // Knowledge base tools
  search_knowledge_base: knowledgeBaseSearchTool,
  // Chess engine
  chess_engine: chessEngineTool,
  retrieve_knowledge_content: knowledgeBaseRetrieveTool,

  // Navigation tool
  navigate_view: navigateViewTool,

  // Jupyter notebook generation
  generate_jupyter_notebook: jupyterNotebookTool,

  // Excel generation
  excel_generation: excelGenerationTool,

  // Financial data
  fmp_financial_data: fmpTool,

  // User-defined skills (LLM-invokable instruction templates)
  skill: skillTool,
} satisfies {
  // PremiumOverlayToolName: implemented by premium overlay packages, supplied at
  // runtime via the externalTools merge - core intentionally has no entry for them.
  [
    key in Exclude<LlmTools, CliLlmTools | 'delegate_to_agent' | SlackLlmTools | PremiumOverlayToolName>
  ]: ToolDefinition;
};

/**
 * `generateTools` / `generateMcpTools` / `generateMcpToolsFromCache` live in the
 * implementation-free `toolGenerators` module so CLI-safe entry points can import
 * them without dragging the full tool graph (and its server-only deps: jimp,
 * @aws-sdk/client-rekognition, write-excel-file) into their bundle. Re-exported
 * here to keep the server barrel's public API unchanged. See issue #660.
 *
 * Note: `generateTools` no longer defaults its `tools` arg to `b4mTools` - that
 * default was the very edge that pulled the whole graph in. Callers pass their
 * tool map explicitly.
 */
export { generateTools, generateMcpTools, generateMcpToolsFromCache } from './toolGenerators';

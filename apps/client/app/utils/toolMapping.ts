import {
  Schedule as DateTimeIcon,
  Casino as DiceIcon,
  Image as ImageIcon,
  Calculate as MathIcon,
  Schema as MermaidIcon,
  Search as SearchIcon,
  Language as WebFetchIcon,
  Science as ScienceIcon,
  WbSunny as WeatherIcon,
  AutoFixHigh as PromptEnhancementIcon,
  BarChart as RechartsIcon,
  History as HistoryIcon,
  NightsStay as MoonIcon,
  WbTwilight as SunriseIcon,
  Satellite as SatelliteIcon,
  FolderOpen as KnowledgeBaseIcon,
  Extension as ChessIcon,
  Hub as HubIcon,
  Functions as WolframIcon,
  DataObject as JupyterIcon,
  TableChart as TableChartIcon,
  ShowChart as FinanceIcon,
  Groups as BobPanelIcon,
} from '@mui/icons-material';
import { B4MLLMTools, OrchestrationDefaultsSchema } from '@bike4mind/common';
import type { SlackLlmTools } from '@bike4mind/services';
import React from 'react';

export interface ToolInfo {
  name: string;
  displayName: string;
  description: string;
  icon: React.ComponentType<any>;
  color?: string;
}

export type PublicTools = Exclude<
  B4MLLMTools,
  // `skill` is auto-enabled server-side when the user has skills defined - invocation is
  // via `/skill-name` slash mentions, not a tool toggle, so it stays out of the UI picker.
  'edit_image' | 'blog_publish' | 'blog_edit' | 'blog_draft' | 'skill' | SlackLlmTools
>;

export const TOOL_MAPPING: Record<PublicTools, ToolInfo> = {
  web_search: {
    name: 'web_search',
    displayName: 'Web Search',
    description: 'Real-time web searches for current information',
    icon: SearchIcon,
    color: '#1976d2',
  },
  web_fetch: {
    name: 'web_fetch',
    displayName: 'Web Fetch',
    description: 'Fetch and process content from specific URLs',
    icon: WebFetchIcon,
    color: '#0288d1',
  },
  wolfram_alpha: {
    name: 'wolfram_alpha',
    displayName: 'Wolfram Alpha',
    description: 'Computational intelligence for math, science, and data',
    icon: WolframIcon,
    color: '#DD1100',
  },
  fmp_financial_data: {
    name: 'fmp_financial_data',
    displayName: 'Financial Data',
    description: 'Stock quotes, company profiles, financial statements, and price history',
    icon: FinanceIcon,
    color: '#4caf50',
  },
  bob_panel_read: {
    name: 'bob_panel_read',
    displayName: 'Bob Panel',
    description: 'A panel of synthetic personas read a site and report where visitors get lost',
    icon: BobPanelIcon,
    color: '#00897b',
  },
  prompt_enhancement: {
    name: 'prompt_enhancement',
    displayName: 'Image Prompt Enhancement',
    description: 'Enhanced image generation prompts',
    icon: PromptEnhancementIcon,
    color: '#7b1fa2',
  },
  deep_research: {
    name: 'deep_research',
    displayName: 'Deep Research',
    description: 'Comprehensive research from multiple sources',
    icon: ScienceIcon,
    color: '#d32f2f',
  },
  image_generation: {
    name: 'image_generation',
    displayName: 'Image Generation',
    description: 'AI-generated images from text descriptions',
    icon: ImageIcon,
    color: '#f57c00',
  },
  mermaid_chart: {
    name: 'mermaid_chart',
    displayName: 'Mermaid Chart',
    description: 'Diagrams and flowcharts visualization',
    icon: MermaidIcon,
    color: '#388e3c',
  },
  weather_info: {
    name: 'weather_info',
    displayName: 'Weather Info',
    description: 'Current weather conditions and forecasts',
    icon: WeatherIcon,
    color: '#fbc02d',
  },
  current_datetime: {
    name: 'current_datetime',
    displayName: 'Current Date/Time',
    description: 'Access to current date and time information',
    icon: DateTimeIcon,
    color: '#5d4037',
  },
  math_evaluate: {
    name: 'math_evaluate',
    displayName: 'Math Evaluate',
    description: 'Precise mathematical calculations and equations',
    icon: MathIcon,
    color: '#303f9f',
  },
  dice_roll: {
    name: 'dice_roll',
    displayName: 'Dice Roll',
    description: 'Virtual dice rolls for randomization',
    icon: DiceIcon,
    color: '#e64a19',
  },
  recharts: {
    name: 'recharts',
    displayName: 'Recharts',
    description: 'Interactive charts and data visualization',
    icon: RechartsIcon,
    color: '#00796b',
  },
  edit_file: {
    name: 'edit_file',
    displayName: 'Edit File',
    description: 'File editing and modification',
    icon: SearchIcon, // Using search icon as placeholder, can be updated later
    color: '#9c27b0',
  },
  // Time Machine & Night Sky tools
  wikipedia_on_this_day: {
    name: 'wikipedia_on_this_day',
    displayName: 'On This Day',
    description: 'Historical events, births, and deaths from Wikipedia',
    icon: HistoryIcon,
    color: '#6d4c41',
  },
  moon_phase: {
    name: 'moon_phase',
    displayName: 'Moon Phase',
    description: 'Current moon phase and lunar calendar information',
    icon: MoonIcon,
    color: '#5c6bc0',
  },
  sunrise_sunset: {
    name: 'sunrise_sunset',
    displayName: 'Sunrise/Sunset',
    description: 'Sunrise, sunset, and twilight times for any location',
    icon: SunriseIcon,
    color: '#ff7043',
  },
  iss_tracker: {
    name: 'iss_tracker',
    displayName: 'ISS Tracker',
    description: 'International Space Station position and crew',
    icon: SatelliteIcon,
    color: '#26a69a',
  },
  planet_visibility: {
    name: 'planet_visibility',
    displayName: 'Planet Visibility',
    description: 'Which planets are visible tonight and their positions',
    icon: MoonIcon, // Using moon icon, could also use a planet-specific one
    color: '#7e57c2',
  },
  // Knowledge base tools
  search_knowledge_base: {
    name: 'search_knowledge_base',
    displayName: 'Knowledge Base',
    description: 'Search and read your uploaded files and documents',
    icon: KnowledgeBaseIcon,
    color: '#7c3aed',
  },
  // Chess engine
  chess_engine: {
    name: 'chess_engine',
    displayName: 'Chess Engine',
    description: 'Play and analyze chess games with move validation and AI opponent',
    icon: ChessIcon,
    color: '#4e342e',
  },
  retrieve_knowledge_content: {
    name: 'retrieve_knowledge_content',
    displayName: 'Knowledge Retrieve',
    description: 'Read content from knowledge base documents',
    icon: KnowledgeBaseIcon,
    color: '#6d28d9',
  },
  // Agent delegation
  delegate_to_agent: {
    name: 'delegate_to_agent',
    displayName: 'Agent Delegation',
    description: 'Delegate tasks to specialized autonomous agents',
    icon: HubIcon,
    color: '#00897b',
  },
  // OptiHashi optimization tools
  optihashi_schedule: {
    name: 'optihashi_schedule',
    displayName: 'Optimization Schedule',
    description: 'Run optimization solvers on scheduling problems',
    icon: HubIcon,
    color: '#00838f',
  },
  optihashi_formulate: {
    name: 'optihashi_formulate',
    displayName: 'Optimization Formulate',
    description: 'Convert natural language to structured optimization problems',
    icon: HubIcon,
    color: '#00695c',
  },
  optihashi_edit_problem: {
    name: 'optihashi_edit_problem',
    displayName: 'Optimization Edit',
    description: 'Edit the active optimization brief from natural language, preserving the rest',
    icon: HubIcon,
    color: '#00796b',
  },
  // Navigation tool
  navigate_view: {
    name: 'navigate_view',
    displayName: 'Navigate View',
    description: 'Suggest contextual navigation to relevant app views',
    icon: SearchIcon,
    color: '#0d47a1',
  },
  // Jupyter notebook generation
  generate_jupyter_notebook: {
    name: 'generate_jupyter_notebook',
    displayName: 'Jupyter Notebook',
    description: 'Generate Jupyter notebooks for data analysis and visualization',
    icon: JupyterIcon,
    color: '#f37626',
  },
  // Excel generation
  excel_generation: {
    name: 'excel_generation',
    displayName: 'Excel Generator',
    description: 'Generate Excel files with formatting, formulas, and multiple sheets',
    icon: TableChartIcon,
    color: '#217346',
  },
};

/**
 * Tool ids (in the UI's vocabulary) that are actually usable when the composer
 * is in **Agent mode** (the Deep Agent / agent_executor path).
 *
 * Agent mode does NOT honor the user's per-message Smart Tools selection. It
 * runs the synthetic orchestration profile's `allowedTools` minus `deniedTools`
 * (see OrchestrationDefaultsSchema in @bike4mind/common). We derive the set from
 * those shared schema defaults at module load so it stays in sync with the
 * server, then apply one alias: the agent's `retrieve_knowledge_content` maps to
 * the UI's `search_knowledge_base` toggle (both are "knowledge base access" to
 * the user). Tool ids that aren't UI toggles (file_read, code_execute,
 * coordinate_task, edit_image) are kept in the set but simply never match a
 * rendered toggle.
 *
 * Caveat: this reflects the DEFAULT agent profile. An org whose admin customizes
 * orchestration tools may differ; this is a best-effort UI hint, not the
 * authorization decision (the server still enforces the real list).
 */
const AGENT_TOOL_UI_ALIASES: Record<string, B4MLLMTools> = {
  retrieve_knowledge_content: 'search_knowledge_base',
};

export const AGENT_MODE_TOOL_IDS: ReadonlySet<string> = (() => {
  const defaults = OrchestrationDefaultsSchema.parse({});
  const denied = new Set(defaults.deniedTools);
  const ids = new Set<string>();
  for (const tool of defaults.allowedTools) {
    if (denied.has(tool)) continue;
    ids.add(AGENT_TOOL_UI_ALIASES[tool] ?? tool);
  }
  return ids;
})();

/** Whether a Smart Tools toggle is honored when the composer is in Agent mode. */
export const isToolAvailableInAgentMode = (toolName: B4MLLMTools): boolean => AGENT_MODE_TOOL_IDS.has(toolName);

export const getToolInfo = (toolName: PublicTools): ToolInfo | undefined => {
  return TOOL_MAPPING[toolName];
};

export const getToolDisplayName = (toolName: PublicTools): string => {
  return TOOL_MAPPING[toolName]?.displayName || toolName;
};

export const getToolDescription = (toolName: PublicTools): string => {
  return TOOL_MAPPING[toolName]?.description || '';
};

export const getToolIcon = (toolName: PublicTools) => {
  return TOOL_MAPPING[toolName]?.icon;
};

export const getToolColor = (toolName: PublicTools): string => {
  return TOOL_MAPPING[toolName]?.color || '#666';
};

/**
 * Category mapping for built-in LLM tools.
 * Used by admin tool definitions to categorize tools.
 */
export const TOOL_CATEGORIES: Record<string, string> = {
  web_search: 'Search',
  web_fetch: 'Search',
  deep_research: 'Search',
  image_generation: 'Generation',
  prompt_enhancement: 'Generation',
  edit_image: 'Generation',
  mermaid_chart: 'Visualization',
  recharts: 'Visualization',
  math_evaluate: 'Utility',
  wolfram_alpha: 'Compute',
  fmp_financial_data: 'Data',
  current_datetime: 'Utility',
  dice_roll: 'Utility',
  weather_info: 'Environment',
  edit_file: 'File Operations',
  blog_publish: 'Content Management',
  blog_edit: 'Content Management',
  blog_draft: 'Content Management',
  // Time Machine & Night Sky tools
  wikipedia_on_this_day: 'Historical',
  moon_phase: 'Astronomy',
  sunrise_sunset: 'Astronomy',
  iss_tracker: 'Astronomy',
  planet_visibility: 'Astronomy',
  // Knowledge base
  search_knowledge_base: 'Search',
  // Chess engine
  chess_engine: 'Games',
  retrieve_knowledge_content: 'Search',
  // Agent delegation
  delegate_to_agent: 'Agents',
  // OptiHashi optimization
  optihashi_schedule: 'Optimization',
  optihashi_formulate: 'Optimization',
  // Bob synthetic-persona panel
  bob_panel_read: 'Feedback',
  // Navigation
  navigate_view: 'Navigation',
  // Jupyter notebook
  generate_jupyter_notebook: 'Data Science',
  // Excel generation
  excel_generation: 'Documents',
};

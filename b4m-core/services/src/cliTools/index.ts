/**
 * CLI Tools - server-side tool execution for the B4M CLI.
 * Runs tools like weather and web search with B4M's company API keys so users
 * don't configure their own; keys stay server-side.
 */

export { executeServerTool } from './executeServerTool';
export type { ToolExecutionRequest, ToolExecutionResult, ServerToolName } from './types';

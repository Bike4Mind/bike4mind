import { fileRead, globFiles, grepSearch } from './fileTools';
import type { ToolDefinition, ToolSchema } from './types';

/**
 * The tools this client offers the model.
 *
 * Read-only for now. Writes, shell execution and the server-side tools (web_search and
 * friends) are the later stages of this work; each needs its own gate, so they are added
 * here only once that gate exists rather than being declared early and refused at run time.
 */
const TOOLS: readonly ToolDefinition[] = [fileRead, globFiles, grepSearch];

const BY_NAME = new Map(TOOLS.map(tool => [tool.schema.name, tool]));

export function findTool(name: string): ToolDefinition | undefined {
  return BY_NAME.get(name);
}

/**
 * Tool declarations for the request body, in the endpoint's `{ toolSchema }` envelope.
 *
 * Returns nothing when no folder is granted: declaring file tools the model can only be
 * denied teaches it to keep retrying, and an undeclared tool is a cleaner "not available"
 * than a tool that always fails.
 */
export function toolsForRequest(roots: readonly string[]): { toolSchema: ToolSchema }[] {
  if (roots.length === 0) return [];
  return TOOLS.map(tool => ({ toolSchema: tool.schema }));
}

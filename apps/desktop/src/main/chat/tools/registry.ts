import { fileRead, globFiles, grepSearch } from './fileTools';
import { bashExecute } from './shellTools';
import { fileEdit, fileWrite } from './writeTools';
import type { ToolDefinition, ToolSchema } from './types';

/**
 * The tools this client offers the model.
 *
 * Reads run unattended; `bash_execute` runs code and the write tools change files, so each
 * declares `approval` and ChatService holds it at the gate until the user answers. A write
 * additionally shows the user the diff it would apply before they answer. The server-side
 * tools (web_search and friends) are a later stage, and are added here only once each has its
 * gate rather than being declared early and refused at run time.
 */
const TOOLS: readonly ToolDefinition[] = [fileRead, globFiles, grepSearch, bashExecute, fileWrite, fileEdit];

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

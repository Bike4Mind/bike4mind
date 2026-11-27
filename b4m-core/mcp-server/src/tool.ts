import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import type { ToolContext } from './context';
import type { ToolsetId } from './toolsets';

/** All four hints are required, with no defaults, so each tool states its blast radius on purpose. */
export interface ToolHints {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDefinition<I extends z.ZodRawShape, O extends z.ZodRawShape> {
  /** `verb_noun` in snake_case, e.g. `list_public_models`. */
  name: string;
  title: string;
  description: string;
  toolset: ToolsetId;
  /** API-key scope needed to list the tool; `null` for a tool that works (or fails gracefully) without one. */
  scope: string | null;
  annotations: ToolHints;
  inputSchema: I;
  outputSchema: O;
  handler: (args: z.infer<z.ZodObject<I>>, ctx: ToolContext) => Promise<CallToolResult>;
}

/** A registered tool with its schemas erased, so differently-typed tools fit in one list. */
export interface Tool {
  name: string;
  title: string;
  description: string;
  toolset: ToolsetId;
  scope: string | null;
  annotations: ToolHints;
  inputSchema: z.ZodRawShape;
  outputSchema: z.ZodRawShape;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<CallToolResult>;
}

export function defineTool<I extends z.ZodRawShape, O extends z.ZodRawShape>(def: ToolDefinition<I, O>): Tool {
  // The MCP server validates `args` against `inputSchema` before the handler runs, so the cast only restores the type.
  return def as unknown as Tool;
}

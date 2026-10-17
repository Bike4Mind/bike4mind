import type { ToolCategory, ToolDescriptor, ToolEffect, ToolSource } from './toolDescriptor.js';

/**
 * Every policy decision about a tool, derived from its descriptor. `undefined` is a tool the
 * catalog could not resolve; it keeps the pre-descriptor fallback (prompt_default, read-only)
 * because feature-module and plugin tools do not register descriptors yet.
 */

const UNKNOWN_TOOL_CATEGORY: ToolCategory = 'prompt_default';

const READ_ONLY_EFFECTS: ReadonlySet<ToolEffect> = new Set<ToolEffect>(['none', 'session', 'read']);

/**
 * How far a source's own declarations are believed. Core, cli and builtin-module tools ship in
 * this repo and are reviewed, so their descriptor is taken as written. A plugin is third-party
 * code the user installed and enabled: it can be trusted per tool after a prompt, but cannot
 * skip the first prompt or claim to be read-only. MCP tools and lifecycle hooks always prompt.
 */
function categoryCeiling(source: ToolSource): ToolCategory | undefined {
  switch (source.kind) {
    case 'mcp':
    case 'hook':
      return 'prompt_always';
    case 'plugin':
      return 'prompt_default';
    default:
      return undefined;
  }
}

function believesDeclaredEffect(source: ToolSource): boolean {
  return categoryCeiling(source) === undefined;
}

export function toolCategory(descriptor: ToolDescriptor | undefined): ToolCategory {
  if (!descriptor) return UNKNOWN_TOOL_CATEGORY;
  const ceiling = categoryCeiling(descriptor.source);
  if (ceiling === 'prompt_always') return ceiling;
  if (ceiling === 'prompt_default' && descriptor.approval === 'auto_approve') return ceiling;
  return descriptor.approval;
}

/** Whether a prompt_default trust decision can be persisted for the tool. */
export function canTrustTool(descriptor: ToolDescriptor | undefined): boolean {
  return toolCategory(descriptor) !== 'prompt_always';
}

/** Read-only tools run in plan mode and in parallel batches; the rest are blocked / sequential. */
export function isReadOnlyTool(descriptor: ToolDescriptor | undefined): boolean {
  if (!descriptor) return true;
  if (!believesDeclaredEffect(descriptor.source)) return false;
  return READ_ONLY_EFFECTS.has(descriptor.effect);
}

/** The shell command text the risk gate classifies, when the tool has one in `args`. */
export function commandTextOf(descriptor: ToolDescriptor | undefined, args: unknown): string | undefined {
  return stringArg(args, descriptor?.commandArg);
}

/** The path a file-writing tool will write, when the tool declares one and `args` carries it. */
export function writePathOf(descriptor: ToolDescriptor | undefined, args: unknown): string | undefined {
  const writePath = stringArg(args, descriptor?.writePathArg);
  return writePath ? writePath : undefined;
}

function stringArg(args: unknown, field: string | undefined): string | undefined {
  if (!field || args === null || typeof args !== 'object') return undefined;
  const value = (args as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

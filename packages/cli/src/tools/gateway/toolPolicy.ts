import type { ToolCategory, ToolDescriptor, ToolEffect, ToolSource } from './toolDescriptor.js';

/**
 * Every policy decision about a tool, derived from its descriptor. `undefined` is a tool the
 * catalog could not resolve; it keeps the pre-descriptor fallback (prompt_default, read-only)
 * because feature-module and plugin tools do not register descriptors yet.
 */

const UNKNOWN_TOOL_CATEGORY: ToolCategory = 'prompt_default';

const READ_ONLY_EFFECTS: ReadonlySet<ToolEffect> = new Set<ToolEffect>(['none', 'session', 'read']);

/** Sources whose self-declared approval tier and effect are not believed. */
function isUntrustedSource(source: ToolSource): boolean {
  return source.kind === 'mcp' || source.kind === 'hook';
}

export function toolCategory(descriptor: ToolDescriptor | undefined): ToolCategory {
  if (!descriptor) return UNKNOWN_TOOL_CATEGORY;
  if (isUntrustedSource(descriptor.source)) return 'prompt_always';
  return descriptor.approval;
}

/** Whether a prompt_default trust decision can be persisted for the tool. */
export function canTrustTool(descriptor: ToolDescriptor | undefined): boolean {
  return toolCategory(descriptor) !== 'prompt_always';
}

/** Read-only tools run in plan mode and in parallel batches; the rest are blocked / sequential. */
export function isReadOnlyTool(descriptor: ToolDescriptor | undefined): boolean {
  if (!descriptor) return true;
  if (isUntrustedSource(descriptor.source)) return false;
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

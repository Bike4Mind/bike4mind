import { CORE_TOOL_DESCRIPTORS } from './coreToolDescriptors.js';
import type { ToolCategory, ToolDescriptor } from './toolDescriptor.js';
import { canTrustTool, isReadOnlyTool, toolCategory } from './toolPolicy.js';

const MCP_PREFIX = 'mcp__';
const HOOK_PREFIXES = ['agent_hook:', 'skill_hook:'] as const;

function isHookName(toolName: string): boolean {
  return HOOK_PREFIXES.some(prefix => toolName.startsWith(prefix));
}

/**
 * Resolve a tool name without a catalog instance: the core table, then the MCP namespace
 * (`mcp__<server>__<tool>`), then the lifecycle-hook namespaces. Undefined means unknown.
 * ToolCatalog.resolve falls back to this after its registered descriptors.
 */
export function resolveStaticToolDescriptor(toolName: string): ToolDescriptor | undefined {
  const core = CORE_TOOL_DESCRIPTORS.get(toolName);
  if (core) return core;
  if (toolName.startsWith(MCP_PREFIX)) {
    const server = toolName.slice(MCP_PREFIX.length).split('__')[0];
    return { source: { kind: 'mcp', server }, effect: 'execute', approval: 'prompt_always' };
  }
  if (isHookName(toolName)) {
    return { source: { kind: 'hook' }, effect: 'execute', approval: 'prompt_always' };
  }
  return undefined;
}

/**
 * Name -> descriptor lookup for one CLI process or ACP stack. Entry points create one and hand
 * it to their PermissionManager, which the permission gateway and the agent's read-only
 * predicate read it through.
 */
export class ToolCatalog {
  private readonly registered = new Map<string, ToolDescriptor>();

  /**
   * Add a descriptor for a tool the core table does not know. Core names and the MCP and hook
   * namespaces are reserved: nothing can re-declare a core tool, or declare itself into a
   * namespace whose descriptor comes from the name alone, with a lower tier.
   */
  register(toolName: string, descriptor: ToolDescriptor): void {
    if (toolName.startsWith(MCP_PREFIX) || isHookName(toolName)) {
      throw new Error(`Tool name "${toolName}" is in a reserved namespace and cannot be registered`);
    }
    if (CORE_TOOL_DESCRIPTORS.has(toolName)) {
      throw new Error(`Tool "${toolName}" is a core tool and already has a descriptor`);
    }
    if (this.registered.has(toolName)) {
      throw new Error(`Tool "${toolName}" already has a registered descriptor`);
    }
    this.registered.set(toolName, descriptor);
  }

  resolve(toolName: string): ToolDescriptor | undefined {
    return this.registered.get(toolName) ?? resolveStaticToolDescriptor(toolName);
  }

  category(toolName: string): ToolCategory {
    return toolCategory(this.resolve(toolName));
  }

  canTrust(toolName: string): boolean {
    return canTrustTool(this.resolve(toolName));
  }

  isReadOnly(toolName: string): boolean {
    return isReadOnlyTool(this.resolve(toolName));
  }
}

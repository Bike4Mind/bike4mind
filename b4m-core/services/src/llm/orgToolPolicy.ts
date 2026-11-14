import { isToolAllowedByOrgPolicy, type ReadOrgModelPolicy } from '@bike4mind/common';

/**
 * Drops the built-in tools the organization's policy does not allow; MCP and other non-built-in tools
 * pass (see isToolAllowedByOrgPolicy). Run it on the fully assembled list so tools added late are covered.
 */
export function applyOrgToolPolicy<T extends { toolSchema: { name: string } }>(
  tools: T[],
  policy: ReadOrgModelPolicy | undefined
): { tools: T[]; stripped: string[] } {
  if (!policy) return { tools, stripped: [] };
  const stripped: string[] = [];
  const kept = tools.filter(tool => {
    const allowed = isToolAllowedByOrgPolicy(policy, tool.toolSchema.name);
    if (!allowed) stripped.push(tool.toolSchema.name);
    return allowed;
  });
  return { tools: kept, stripped };
}

/** The requested tool names the organization's policy does not allow. */
export function orgDisallowedTools(names: readonly string[], policy: ReadOrgModelPolicy | undefined): string[] {
  if (!policy) return [];
  return names.filter(name => !isToolAllowedByOrgPolicy(policy, name));
}

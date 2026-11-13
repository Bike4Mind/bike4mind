import { describe, expect, it } from 'vitest';
import type { OrgModelPolicy } from '@bike4mind/common';
import { applyOrgToolPolicy, orgDisallowedTools } from './orgToolPolicy';

const tool = (name: string) => ({ toolSchema: { name } });
const tools = [tool('web_search'), tool('search_knowledge_base'), tool('retrieve_knowledge_content'), tool('srv__x')];
const policy = (allowedTools: string[] | null): OrgModelPolicy => ({
  allowedProviders: null,
  allowedModels: null,
  allowedTools,
});
const names = (list: { toolSchema: { name: string } }[]) => list.map(t => t.toolSchema.name);

describe('applyOrgToolPolicy', () => {
  it('passes every tool for no policy or an unrestricted tool list', () => {
    expect(applyOrgToolPolicy(tools, null).tools).toBe(tools);
    expect(applyOrgToolPolicy(tools, undefined).stripped).toEqual([]);
    expect(names(applyOrgToolPolicy(tools, policy(null)).tools)).toEqual(names(tools));
  });

  it('strips every built-in tool for an empty list but keeps MCP tools', () => {
    const result = applyOrgToolPolicy(tools, policy([]));
    expect(names(result.tools)).toEqual(['srv__x']);
    expect(result.stripped).toEqual(['web_search', 'search_knowledge_base', 'retrieve_knowledge_content']);
  });

  it('keeps the companion of an allowed tool', () => {
    expect(names(applyOrgToolPolicy(tools, policy(['search_knowledge_base'])).tools)).toEqual([
      'search_knowledge_base',
      'retrieve_knowledge_content',
      'srv__x',
    ]);
  });

  it('strips every built-in tool for an invalid stored policy', () => {
    expect(names(applyOrgToolPolicy(tools, 'invalid').tools)).toEqual(['srv__x']);
  });
});

describe('orgDisallowedTools', () => {
  it('names only the governed tools the policy refuses', () => {
    expect(orgDisallowedTools(['web_search', 'srv__x', 'search_knowledge_base'], policy(['web_search']))).toEqual([
      'search_knowledge_base',
    ]);
    expect(orgDisallowedTools(['web_search'], null)).toEqual([]);
  });
});

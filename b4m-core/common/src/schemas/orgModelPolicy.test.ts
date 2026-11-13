import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelBackend } from '../models';
import {
  INVALID_ORG_MODEL_POLICY,
  isModelAllowedByOrgPolicy,
  isToolAllowedByOrgPolicy,
  OrgModelPolicySchema,
  readOrgModelPolicy,
  type OrgModelPolicy,
} from './orgModelPolicy';

const policy = (p: Partial<OrgModelPolicy>): OrgModelPolicy => OrgModelPolicySchema.parse(p);

describe('OrgModelPolicySchema', () => {
  it('defaults every list to null (unrestricted)', () => {
    expect(OrgModelPolicySchema.parse({})).toEqual({
      allowedProviders: null,
      allowedModels: null,
      allowedTools: null,
    });
  });

  it('rejects an empty provider or model list so an org cannot lock out every model', () => {
    expect(OrgModelPolicySchema.safeParse({ allowedProviders: [] }).success).toBe(false);
    expect(OrgModelPolicySchema.safeParse({ allowedModels: [] }).success).toBe(false);
  });

  it('accepts an empty tool list', () => {
    expect(OrgModelPolicySchema.parse({ allowedTools: [] }).allowedTools).toEqual([]);
  });

  it('rejects unknown providers, unknown tools, blank model ids and extra keys', () => {
    expect(OrgModelPolicySchema.safeParse({ allowedProviders: ['nope'] }).success).toBe(false);
    expect(OrgModelPolicySchema.safeParse({ allowedTools: ['not_a_tool'] }).success).toBe(false);
    expect(OrgModelPolicySchema.safeParse({ allowedModels: ['  '] }).success).toBe(false);
    expect(OrgModelPolicySchema.safeParse({ allowedModels: null, extra: 1 }).success).toBe(false);
  });
});

describe('readOrgModelPolicy', () => {
  it('reads absent, null and an all-unset subdocument as unrestricted', () => {
    expect(readOrgModelPolicy(undefined)).toBeNull();
    expect(readOrgModelPolicy(null)).toBeNull();
    expect(readOrgModelPolicy({})).toBeNull();
    expect(readOrgModelPolicy({ allowedProviders: undefined, allowedModels: undefined })).toBeNull();
  });

  it('reads a subdocument through toObject and ignores _id', () => {
    const raw = { toObject: () => ({ _id: 'x', allowedTools: ['web_search'] }) };
    expect(readOrgModelPolicy(raw)).toEqual({
      allowedProviders: null,
      allowedModels: null,
      allowedTools: ['web_search'],
    });
  });

  it("returns 'invalid' for a stored row that no longer parses", () => {
    expect(readOrgModelPolicy({ allowedProviders: [] })).toBe(INVALID_ORG_MODEL_POLICY);
    expect(readOrgModelPolicy({ allowedModels: 'gpt-4o' })).toBe(INVALID_ORG_MODEL_POLICY);
    expect(readOrgModelPolicy('nonsense')).toBe(INVALID_ORG_MODEL_POLICY);
    expect(readOrgModelPolicy([])).toBe(INVALID_ORG_MODEL_POLICY);
  });
});

describe('readOrgModelPolicy with stale enum members', () => {
  afterEach(() => vi.restoreAllMocks());

  it('drops an unknown provider or tool with a warning instead of failing the row closed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      readOrgModelPolicy({
        allowedProviders: ['openai', 'retired-provider'],
        allowedTools: ['web_search', 'removed_tool'],
      })
    ).toEqual({ allowedProviders: ['openai'], allowedModels: null, allowedTools: ['web_search'] });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(readOrgModelPolicy({ allowedTools: ['removed_tool'] })).toEqual({
      allowedProviders: null,
      allowedModels: null,
      allowedTools: [],
    });
  });

  it('stays deny-all when every listed provider is unknown, and for a structurally broken row', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(readOrgModelPolicy({ allowedProviders: ['retired-provider'] })).toBe(INVALID_ORG_MODEL_POLICY);
    expect(readOrgModelPolicy({ allowedProviders: [1] })).toBe(INVALID_ORG_MODEL_POLICY);
    expect(readOrgModelPolicy({ allowedTools: 'web_search' })).toBe(INVALID_ORG_MODEL_POLICY);
  });

  it('does not warn for a policy whose members are all known', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readOrgModelPolicy({ allowedProviders: ['openai'], allowedTools: ['web_search'], allowedModels: ['gpt-4o'] });
    readOrgModelPolicy({ allowedTools: null });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('isModelAllowedByOrgPolicy', () => {
  const model = { id: 'gpt-4o', backend: ModelBackend.OpenAI };

  it('allows everything with no policy and nothing with an invalid one', () => {
    expect(isModelAllowedByOrgPolicy(null, model)).toBe(true);
    expect(isModelAllowedByOrgPolicy(INVALID_ORG_MODEL_POLICY, model)).toBe(false);
  });

  it('requires both the provider list and the model list to admit the model', () => {
    const both = policy({ allowedProviders: [ModelBackend.OpenAI], allowedModels: ['gpt-4o'] });
    expect(isModelAllowedByOrgPolicy(both, model)).toBe(true);
    expect(isModelAllowedByOrgPolicy(both, { id: 'gpt-4o-mini', backend: ModelBackend.OpenAI })).toBe(false);
    const wrongProvider = policy({ allowedProviders: [ModelBackend.Anthropic], allowedModels: ['gpt-4o'] });
    expect(isModelAllowedByOrgPolicy(wrongProvider, model)).toBe(false);
  });

  it('refuses a model with no known backend once providers are restricted', () => {
    const p = policy({ allowedProviders: [ModelBackend.OpenAI] });
    expect(isModelAllowedByOrgPolicy(p, { id: 'gpt-4o' })).toBe(false);
    expect(isModelAllowedByOrgPolicy(p, { id: 'gpt-4o', backend: null })).toBe(false);
    expect(isModelAllowedByOrgPolicy(policy({ allowedModels: ['gpt-4o'] }), { id: 'gpt-4o' })).toBe(true);
  });

  it('resolves a media model backend when none is given', () => {
    const p = policy({ allowedProviders: [ModelBackend.BFL] });
    expect(isModelAllowedByOrgPolicy(p, { id: 'flux-pro' })).toBe(true);
    expect(isModelAllowedByOrgPolicy(p, { id: 'gpt-image-1' })).toBe(false);
  });

  it('never replaces an authoritative unrepresentable provider with an OpenAI-looking model id', () => {
    const p = policy({ allowedProviders: [ModelBackend.OpenAI] });
    expect(isModelAllowedByOrgPolicy(p, { id: 'gpt-image-1' })).toBe(true);
    expect(isModelAllowedByOrgPolicy(p, { id: 'gpt-image-1', backend: null })).toBe(false);
    expect(
      isModelAllowedByOrgPolicy(policy({ allowedModels: ['gpt-image-1'] }), { id: 'gpt-image-1', backend: null })
    ).toBe(true);
  });

  it('matches an allowlisted retired id against its successor only when a resolver is given', () => {
    const p = policy({ allowedModels: ['old-model'] });
    const resolve = (id: string) => (id === 'old-model' ? 'new-model' : id);
    expect(isModelAllowedByOrgPolicy(p, { id: 'new-model' }, resolve)).toBe(true);
    expect(isModelAllowedByOrgPolicy(p, { id: 'new-model' })).toBe(false);
    expect(isModelAllowedByOrgPolicy(p, { id: 'other-model' }, resolve)).toBe(false);
  });
});

describe('isToolAllowedByOrgPolicy', () => {
  it('allows every tool with no policy or no tool list', () => {
    expect(isToolAllowedByOrgPolicy(null, 'web_search')).toBe(true);
    expect(isToolAllowedByOrgPolicy(policy({ allowedModels: ['gpt-4o'] }), 'web_search')).toBe(true);
  });

  it('withholds every governed built-in tool for an empty list, but not MCP or coordinator tools', () => {
    const none = policy({ allowedTools: [] });
    expect(isToolAllowedByOrgPolicy(none, 'web_search')).toBe(false);
    expect(isToolAllowedByOrgPolicy(none, 'github__create_issue')).toBe(true);
    expect(isToolAllowedByOrgPolicy(none, 'coordinate_task')).toBe(true);
  });

  it('fails closed on governed tools for an invalid policy', () => {
    expect(isToolAllowedByOrgPolicy(INVALID_ORG_MODEL_POLICY, 'web_search')).toBe(false);
    expect(isToolAllowedByOrgPolicy(INVALID_ORG_MODEL_POLICY, 'github__create_issue')).toBe(true);
  });

  it('keeps the companions of an allowed tool', () => {
    const p = policy({ allowedTools: ['search_knowledge_base', 'image_generation', 'save_content_to_data_lake'] });
    for (const name of [
      'retrieve_knowledge_content',
      'count_knowledge_base',
      'describe_knowledge_base',
      'edit_image',
      'list_my_data_lakes',
      'create_data_lake',
    ]) {
      expect(isToolAllowedByOrgPolicy(p, name)).toBe(true);
    }
    expect(isToolAllowedByOrgPolicy(p, 'web_search')).toBe(false);
  });

  it('does not pull a trigger in from its companion', () => {
    const p = policy({ allowedTools: ['edit_image', 'retrieve_knowledge_content'] });
    expect(isToolAllowedByOrgPolicy(p, 'image_generation')).toBe(false);
    expect(isToolAllowedByOrgPolicy(p, 'search_knowledge_base')).toBe(false);
  });
});

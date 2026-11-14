import { describe, expect, it, vi } from 'vitest';
import { OrgModelPolicySchema } from '@bike4mind/common';

vi.mock('@bike4mind/database', () => ({ organizationRepository: {} }));

import { diffOrgModelPolicy, toOrgModelPolicyView } from './orgModelPolicy';

const policy = (fields: Record<string, unknown>) => OrgModelPolicySchema.parse(fields);

describe('diffOrgModelPolicy', () => {
  it('lists only the fields whose value changed', () => {
    const before = toOrgModelPolicyView({ allowedModels: ['a'], allowedTools: ['web_search'] });
    const changes = diffOrgModelPolicy(before, policy({ allowedModels: ['b'], allowedTools: ['web_search'] }));
    expect(changes).toEqual([{ field: 'allowedModels', before: ['a'], after: ['b'] }]);
  });

  it('records nothing for a no-op save', () => {
    const before = toOrgModelPolicyView({ allowedModels: ['a'] });
    expect(diffOrgModelPolicy(before, policy({ allowedModels: ['a'] }))).toEqual([]);
  });

  it('over an invalid stored row, records every field the new policy sets and skips null-to-null', () => {
    const before = toOrgModelPolicyView({ allowedProviders: [] });
    expect(before.invalidStored).toBe(true);
    const changes = diffOrgModelPolicy(before, policy({ allowedModels: ['a'] }));
    expect(changes).toEqual([{ field: 'allowedModels', before: null, after: ['a'] }]);
  });

  it('still records nothing over an invalid stored row reset to unrestricted', () => {
    const before = toOrgModelPolicyView({ allowedProviders: [] });
    expect(diffOrgModelPolicy(before, policy({}))).toEqual([]);
  });
});

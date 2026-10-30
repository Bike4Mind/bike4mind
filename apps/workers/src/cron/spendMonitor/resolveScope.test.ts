import { describe, expect, it, vi } from 'vitest';
import { resolveScopes, type ResolveScopeDeps } from './resolveScope';

const makeDeps = (overrides: Partial<ResolveScopeDeps> = {}): ResolveScopeDeps => ({
  findUsersByIds: vi.fn(async ids =>
    [
      { id: 'u1', email: 'ada@example.com', name: 'Ada' },
      { id: 'u2', email: 'bob@example.com', name: 'Bob' },
    ].filter(user => ids.includes(user.id))
  ),
  findOrganizationsByIds: vi.fn(async ids => [{ id: 'o1', name: 'Acme' }].filter(org => ids.includes(org.id))),
  findApiKeysByIds: vi.fn(async ids =>
    [
      { id: 'k1', name: 'ci-key', userId: 'u1' },
      { id: 'k2', name: 'org-key', userId: 'u2', billingOwnerType: 'Organization', organizationId: 'o1' },
      { id: 'k3', name: 'orphan-key', userId: 'gone' },
    ].filter(key => ids.includes(key.id))
  ),
  findAgentsByIds: vi.fn(async ids =>
    [
      { id: 'a1', name: 'Helper', userId: 'u1' },
      { id: 'a2', name: 'Shared', organizationId: 'o1' },
      { id: 'a3', name: 'Lost', userId: 'gone' },
    ].filter(agent => ids.includes(agent.id))
  ),
  ...overrides,
});

describe('resolveScopes', () => {
  it('resolves a user to its email and admin page', async () => {
    const result = await resolveScopes([{ scopeType: 'User', scopeId: 'u1' }], makeDeps());
    expect(result.get('User:u1')).toEqual({
      label: 'ada@example.com',
      payerType: 'User',
      payerId: 'u1',
      adminPath: '/admin/users/u1',
    });
  });

  it('resolves an organization to its name with no admin path', async () => {
    const result = await resolveScopes([{ scopeType: 'Organization', scopeId: 'o1' }], makeDeps());
    expect(result.get('Organization:o1')).toEqual({
      label: 'Acme',
      payerType: 'Organization',
      payerId: 'o1',
      adminPath: null,
    });
  });

  it('falls back to the owner user as the payer of a personal api key', async () => {
    const result = await resolveScopes([{ scopeType: 'apiKey', scopeId: 'k1' }], makeDeps());
    expect(result.get('apiKey:k1')).toEqual({
      label: 'ci-key (ada@example.com)',
      payerType: 'User',
      payerId: 'u1',
      adminPath: '/admin/users/u1',
    });
  });

  it('makes the billing organization the payer of an org-billed api key', async () => {
    const result = await resolveScopes([{ scopeType: 'apiKey', scopeId: 'k2' }], makeDeps());
    expect(result.get('apiKey:k2')).toEqual({
      label: 'org-key (bob@example.com)',
      payerType: 'Organization',
      payerId: 'o1',
      adminPath: '/admin/users/u2',
    });
  });

  it('labels an agent with its owner and links the owner page', async () => {
    const result = await resolveScopes([{ scopeType: 'Agent', scopeId: 'a1' }], makeDeps());
    expect(result.get('Agent:a1')).toEqual({
      label: 'agent Helper of ada@example.com',
      payerType: 'User',
      payerId: 'u1',
      adminPath: '/admin/users/u1',
    });
  });

  it('bills an org-shared agent to its organization', async () => {
    const result = await resolveScopes([{ scopeType: 'Agent', scopeId: 'a2' }], makeDeps());
    expect(result.get('Agent:a2')).toEqual({
      label: 'agent Shared',
      payerType: 'Organization',
      payerId: 'o1',
      adminPath: null,
    });
  });

  it('uses the owner id when the owner user is missing', async () => {
    const result = await resolveScopes(
      [
        { scopeType: 'apiKey', scopeId: 'k3' },
        { scopeType: 'Agent', scopeId: 'a3' },
      ],
      makeDeps()
    );
    expect(result.get('apiKey:k3')?.label).toBe('orphan-key (gone)');
    expect(result.get('apiKey:k3')?.payerId).toBe('gone');
    expect(result.get('Agent:a3')).toMatchObject({ label: 'agent Lost of gone', payerType: 'User', payerId: 'gone' });
  });

  it('marks missing and unsupported scopes unknown', async () => {
    const result = await resolveScopes(
      [
        { scopeType: 'User', scopeId: 'nobody' },
        { scopeType: 'Agent', scopeId: 'deleted' },
        { scopeType: 'platform', scopeId: 'all' },
        { scopeType: 'model', scopeId: 'gpt-x' },
      ],
      makeDeps()
    );
    const unknown = (label: string) => ({ label, payerType: 'unknown', payerId: null, adminPath: null });
    expect(result.get('User:nobody')).toEqual(unknown('User nobody'));
    expect(result.get('Agent:deleted')).toEqual(unknown('Agent deleted'));
    expect(result.get('platform:all')).toEqual(unknown('platform all'));
    expect(result.get('model:gpt-x')).toEqual(unknown('model gpt-x'));
  });

  it('batches one lookup per type, folding owners into a single user lookup', async () => {
    const deps = makeDeps();
    await resolveScopes(
      [
        { scopeType: 'User', scopeId: 'u2' },
        { scopeType: 'User', scopeId: 'u2' },
        { scopeType: 'apiKey', scopeId: 'k1' },
        { scopeType: 'apiKey', scopeId: 'k2' },
        { scopeType: 'Agent', scopeId: 'a1' },
      ],
      deps
    );
    expect(deps.findUsersByIds).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.findUsersByIds).mock.calls[0]?.[0].sort()).toEqual(['u1', 'u2']);
    expect(deps.findApiKeysByIds).toHaveBeenCalledTimes(1);
    expect(deps.findAgentsByIds).toHaveBeenCalledTimes(1);
  });

  it('skips the user lookup when no scope needs one', async () => {
    const deps = makeDeps();
    await resolveScopes([{ scopeType: 'Organization', scopeId: 'o1' }], deps);
    expect(deps.findUsersByIds).not.toHaveBeenCalled();
  });
});

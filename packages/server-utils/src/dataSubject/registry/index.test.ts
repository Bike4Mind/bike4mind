import { describe, expect, it, vi } from 'vitest';
import { DATA_HOLDER_REGISTRY, findUnclassifiedModels, mergeRegistries } from './index';
import { holderExportScope } from '../exportScope';
import { SubjectMatcher } from '../subjectMatcher';
import type { DataHolderRegistry } from '../types';

vi.mock('sst', () => ({ Resource: new Proxy({}, { get: () => ({ value: 'test', name: 'test' }) }) }));

const noData = { kind: 'noUserData', note: 'test' } as const;

describe('organization retention personal-data policy', () => {
  it('deletes actor-owned estimates and withholds their confirmation tokens', () => {
    const holder = DATA_HOLDER_REGISTRY.OrganizationRetentionEstimate;
    if (holder.kind !== 'holder') throw new Error('Estimate must be a holder');
    expect(holder.references).toEqual([{ path: 'actorUserId', matchBy: 'userId', action: 'deleteDocument' }]);
    expect(holder.secretPaths).toContain('token');
  });
  it('anonymizes the creator while retaining immutable organization media ownership', () => {
    const holder = DATA_HOLDER_REGISTRY.OrganizationGeneratedObject;
    if (holder.kind !== 'holder') throw new Error('Generated object must be a holder');
    expect(holder.references).toEqual([{ path: 'userId', matchBy: 'userId', action: 'anonymize' }]);
  });
});

describe('organization library personal-data policy', () => {
  it('keeps organization-owned snapshots independent of an individual author erasure', () => {
    expect(DATA_HOLDER_REGISTRY.OrganizationLibrary).toEqual({
      kind: 'noUserData',
      note: 'Organization-owned definition snapshots with no author identity or personal source reference.',
    });
    expect(findUnclassifiedModels(['OrganizationLibrary'])).toEqual([]);
  });
});

describe('organization audit personal-data policy', () => {
  it('classifies membership target IDs in analytics as attribution on another account record', () => {
    const holder = DATA_HOLDER_REGISTRY.CounterLog;
    if (holder.kind !== 'holder') throw new Error('CounterLog must be a holder');
    const references = holder.references.filter(reference => reference.path === 'metadata.userId');
    expect(references).toHaveLength(1);
    expect(references[0].action).toBe('anonymize');
    expect(holderExportScope(references.map(reference => ({ reference, throughArray: false })))).toEqual({
      scope: 'matchedPaths',
      paths: ['metadata.userId'],
    });
  });

  it('retains actor records and qualifies user targets by their member actions', () => {
    const holder = DATA_HOLDER_REGISTRY.OrganizationAuditEvent;
    if (holder.kind !== 'holder') throw new Error('OrganizationAuditEvent must be a holder');
    const actors = holder.references.filter(reference => reference.path === 'actorUserId');
    expect(actors).toHaveLength(1);
    expect(actors[0].where).toBeUndefined();
    const targets = holder.references.filter(reference => reference.path === 'targetId');
    expect(targets.map(reference => reference.where)).toEqual([
      { action: 'member.added' },
      { action: 'member.removed' },
    ]);
    expect(targets.every(reference => reference.action === 'retain')).toBe(true);
    expect(holderExportScope(targets.map(reference => ({ reference, throughArray: false })))).toEqual({
      scope: 'wholeDocument',
    });
  });
});

describe('organization role lists', () => {
  it('pulls the user from billingManagerUserIds like the other role lists', () => {
    const holder = DATA_HOLDER_REGISTRY.Organization;
    if (holder.kind !== 'holder') throw new Error('Organization must be a holder');
    const lists = holder.references.filter(reference => reference.path === 'billingManagerUserIds');
    expect(lists).toHaveLength(1);
    expect(lists[0]).toMatchObject({ matchBy: 'userId', action: 'pullFromArray' });
  });
});

describe('core tutorial personal-data policy', () => {
  it("deletes the person's own tutorial progress", () => {
    expect(DATA_HOLDER_REGISTRY.CoreTutorialProgress).toEqual({
      kind: 'holder',
      references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
    });
  });
  it('keeps admin-written tutorial content and anonymizes its author', () => {
    const authorPaths = {
      CoreTutorialDraft: ['capturedBy', 'updatedBy'],
      CoreTutorialOverride: ['updatedBy'],
      CoreTutorialOverrideChange: ['actorId'],
    };
    for (const [model, paths] of Object.entries(authorPaths)) {
      expect(DATA_HOLDER_REGISTRY[model], model).toEqual({
        kind: 'holder',
        references: paths.map(path => ({ path, matchBy: 'userId', action: 'anonymize' })),
      });
    }
  });
});

describe('findUnclassifiedModels', () => {
  it('returns the names the registry does not classify', () => {
    expect(findUnclassifiedModels(['User', 'NotARealModel'])).toEqual(['NotARealModel']);
  });

  it('does not treat Object.prototype keys as classified', () => {
    expect(findUnclassifiedModels(['constructor'])).toEqual(['constructor']);
  });
});

describe('mergeRegistries', () => {
  it('merges disjoint registries', () => {
    const a: DataHolderRegistry = { A: noData };
    const b: DataHolderRegistry = { B: noData };
    expect(Object.keys(mergeRegistries([a, b])).sort()).toEqual(['A', 'B']);
  });

  it('throws when a model is classified in two registries', () => {
    const a: DataHolderRegistry = { A: noData };
    expect(() => mergeRegistries([a, a])).toThrow(/classified twice/);
  });
});

describe('persona credential classification', () => {
  it('excludes the persisted one-use login verifier from user exports', () => {
    const user = DATA_HOLDER_REGISTRY.User;
    expect(user.kind).toBe('subject');
    if (user.kind !== 'subject') throw new Error('User must be a data subject');
    expect(user.secretPaths).toContain('personaLoginCodeHash');
  });
});

describe('private feedback note export policy', () => {
  it.each(['userId', 'author.id'])('excludes bodies from whole-record export policy for %s', path => {
    const holder = DATA_HOLDER_REGISTRY.FeedbackNote;
    if (holder.kind !== 'holder') throw new Error('FeedbackNote must be a holder');
    const references = holder.references.filter(reference => reference.path === path);
    expect(references).toHaveLength(1);
    expect(holderExportScope(references.map(reference => ({ reference, throughArray: false })))).toEqual({
      scope: 'wholeDocument',
    });
    expect(holder.secretPaths).toContain('body');
  });
});

describe('account purge reconciliation', () => {
  const userId = '0123456789abcdef01234567';
  const matched = (model: string, document: Record<string, unknown>) => {
    const holder = DATA_HOLDER_REGISTRY[model];
    if (holder.kind !== 'holder') throw new Error(`${model} must be a holder`);
    const matcher = new SubjectMatcher({ userId, email: null });
    return holder.references.filter(reference => matcher.matches(document, reference)).map(({ action }) => action);
  };

  it('deletes a live memory key but keeps the tombstone the purge leaves as a fence', () => {
    const key = { ownerUserId: userId, principalKind: 'user', principalId: userId };
    expect(matched('MemoryPrincipalKey', { ...key, dek: 'wrapped' })).toEqual(['deleteDocument', 'deleteDocument']);
    expect(matched('MemoryPrincipalKey', key)).toContain('retain');
    expect(matched('MemoryPrincipalKey', { ...key, dek: null })).toContain('retain');
  });

  it("deletes a person's own MCP connections and only anonymizes the creator of a shared one", () => {
    expect(matched('McpConnection', { ownerType: 'user', ownerKey: userId, userId })).toEqual(['deleteDocument']);
    expect(matched('McpConnection', { ownerType: 'org', ownerKey: 'org-1', userId })).toEqual(['anonymize']);
    expect(matched('McpConnection', { ownerType: 'platform', ownerKey: 'platform', userId })).toEqual(['anonymize']);
  });

  it("deletes a person's saved functions and leaves another person's alone", () => {
    expect(matched('CallableFunction', { ownerType: 'user', ownerKey: userId, userId })).toEqual(['deleteDocument']);
    expect(matched('CallableFunction', { ownerType: 'user', ownerKey: 'other', userId: 'other' })).toEqual([]);
  });

  it("deletes the recipients' reviews of a person's functions before the functions go", () => {
    expect(DATA_HOLDER_REGISTRY.CallableFunction).toMatchObject({
      beforeErasure: ['deleteReviewsOfOwnedCallableFunctions'],
    });
  });

  it("removes a person from the grants of another person's shared function", () => {
    const shared = { ownerType: 'user', ownerKey: 'other', userId: 'other' };
    expect(matched('CallableFunction', { ...shared, grants: { userIds: ['x', userId] } })).toEqual(['pullFromArray']);
    expect(matched('CallableFunction', { ...shared, grants: { userIds: ['x'] } })).toEqual([]);
  });

  it("deletes a person's reviews of functions shared with them and leaves another person's alone", () => {
    expect(matched('CallableFunctionReview', { functionId: 'fn-1', userId })).toEqual(['deleteDocument']);
    expect(matched('CallableFunctionReview', { functionId: 'fn-1', userId: 'other' })).toEqual([]);
  });

  it("deletes the function call rows a person made, and only names the owner on someone else's call", () => {
    expect(matched('CallableFunctionCall', { callerUserId: userId, ownerUserId: userId })).toEqual([
      'deleteDocument',
      'anonymize',
    ]);
    expect(matched('CallableFunctionCall', { callerUserId: userId, ownerUserId: 'other' })).toEqual(['deleteDocument']);
    expect(matched('CallableFunctionCall', { callerUserId: 'other', ownerUserId: 'other' })).toEqual([]);

    const holder = DATA_HOLDER_REGISTRY.CallableFunctionCall;
    if (holder.kind !== 'holder') throw new Error('CallableFunctionCall must be a holder');
    const recipientCall = {
      callerUserId: 'recipient',
      organizationId: 'org-1',
      apiKeyId: 'key-1',
      ownerUserId: userId,
    };
    const matcher = new SubjectMatcher({ userId, email: null });
    const ownerMatches = holder.references
      .filter(reference => matcher.matches(recipientCall, reference))
      .map(reference => ({ reference, throughArray: false }));
    expect(ownerMatches.map(match => match.reference.action)).toEqual(['anonymize']);
    expect(holderExportScope(ownerMatches)).toEqual({ scope: 'matchedPaths', paths: ['ownerUserId'] });
  });

  it("deletes the asynchronous call results a person is waiting on, and no one else's", () => {
    expect(matched('CallableFunctionResult', { callerUserId: userId })).toEqual(['deleteDocument']);
    expect(matched('CallableFunctionResult', { callerUserId: 'other' })).toEqual([]);
  });

  it('deletes only a personal project and anonymizes the owner of an organization one', () => {
    const holder = DATA_HOLDER_REGISTRY.Project;
    if (holder.kind !== 'holder') throw new Error('Project must be a holder');
    const owner = holder.references.filter(reference => reference.path === 'userId');
    expect(owner).toEqual([
      { path: 'userId', matchBy: 'userId', action: 'deleteDocument', scope: 'personal' },
      { path: 'userId', matchBy: 'userId', action: 'anonymize' },
    ]);
  });

  it.each([
    'SessionModel',
    'AgentExecution',
    'LatticeModel',
    'QuestExternalLink',
    'ResearchData',
    'ResearchTask',
    'WorkItem',
  ] as const)('deletes only a personal %s and anonymizes the owner of an organization one', model => {
    const holder = DATA_HOLDER_REGISTRY[model];
    if (holder.kind !== 'holder') throw new Error(`${model} must be a holder`);
    expect(holder.references.filter(reference => reference.path === 'userId')).toEqual([
      { path: 'userId', matchBy: 'userId', action: 'deleteDocument', scope: 'personal' },
      { path: 'userId', matchBy: 'userId', action: 'anonymize' },
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { DATA_HOLDER_REGISTRY, findUnclassifiedModels, mergeRegistries } from './index';
import { holderExportScope } from '../exportScope';
import type { DataHolderRegistry } from '../types';

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

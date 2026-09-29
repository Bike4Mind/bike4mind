import { describe, it, expect } from 'vitest';
import { findInstallationPolicyViolation, pickRepositoryToBind } from './lakeAppPolicy';
import type { GitHubLakeRepository } from './lakeAppClient';

describe('findInstallationPolicyViolation', () => {
  it('accepts selected-repositories with exactly contents:read + metadata:read', () => {
    expect(
      findInstallationPolicyViolation({
        repositorySelection: 'selected',
        permissions: { contents: 'read', metadata: 'read' },
      })
    ).toBeNull();
  });

  it('rejects an installation on all repositories', () => {
    expect(
      findInstallationPolicyViolation({
        repositorySelection: 'all',
        permissions: { contents: 'read', metadata: 'read' },
      })
    ).toBe('all_repositories');
  });

  it('rejects an extra granted permission beyond contents/metadata', () => {
    expect(
      findInstallationPolicyViolation({
        repositorySelection: 'selected',
        permissions: { contents: 'read', metadata: 'read', issues: 'read' },
      })
    ).toBe('excess_permissions');
  });

  it('rejects contents write access, not just an extra scope', () => {
    expect(
      findInstallationPolicyViolation({
        repositorySelection: 'selected',
        permissions: { contents: 'write', metadata: 'read' },
      })
    ).toBe('excess_permissions');
  });

  it('flags a missing contents:read when only metadata:read is granted', () => {
    expect(
      findInstallationPolicyViolation({
        repositorySelection: 'selected',
        permissions: { metadata: 'read' },
      })
    ).toBe('missing_contents_read');
  });

  it('ignores permission keys whose value is undefined', () => {
    expect(
      findInstallationPolicyViolation({
        repositorySelection: 'selected',
        permissions: { contents: 'read', metadata: 'read', issues: undefined },
      })
    ).toBeNull();
  });
});

describe('pickRepositoryToBind', () => {
  const repo = (id: number, fullName: string): GitHubLakeRepository => ({ id, fullName });

  it('picks the single unbound repository', () => {
    const result = pickRepositoryToBind([repo(1, 'acme/one'), repo(2, 'acme/two')], new Set([1]));
    expect(result).toEqual({ kind: 'picked', repository: repo(2, 'acme/two') });
  });

  it('reports none_unbound when the visible list is empty', () => {
    expect(pickRepositoryToBind([], new Set())).toEqual({ kind: 'none_unbound' });
  });

  it('reports none_unbound when every visible repository is already bound', () => {
    expect(pickRepositoryToBind([repo(1, 'acme/one')], new Set([1]))).toEqual({ kind: 'none_unbound' });
  });

  it('reports ambiguous with the unbound count when more than one repository is unclaimed', () => {
    const result = pickRepositoryToBind(
      [repo(1, 'acme/one'), repo(2, 'acme/two'), repo(3, 'acme/three')],
      new Set([3])
    );
    expect(result).toEqual({ kind: 'ambiguous', unboundCount: 2 });
  });
});

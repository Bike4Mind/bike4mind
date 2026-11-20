import { describe, it, expect } from 'vitest';
import { findInstallationPolicyViolation } from './lakeAppPolicy';

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

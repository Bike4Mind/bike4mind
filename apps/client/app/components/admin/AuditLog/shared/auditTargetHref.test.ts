import { describe, expect, it } from 'vitest';
import { auditTargetHref } from './auditTargetHref';

describe('auditTargetHref', () => {
  it('encodes user ids as one path segment', () => {
    expect(auditTargetHref({ kind: 'user', id: 'user/a?b', displayName: 'User' })).toBe('/admin/users/user%2Fa%3Fb');
  });

  it('opens the organization record through its existing URL state', () => {
    expect(auditTargetHref({ kind: 'organization', id: 'org-1', displayName: 'Organization' })).toBe(
      '/admin?tab=organizations&orgId=org-1'
    );
  });

  it('locates a setting without putting its value in the URL', () => {
    expect(auditTargetHref({ kind: 'settings', id: 'logoSettings', displayName: 'Setting' })).toBe(
      '/admin?tab=admin-settings&q=logoSettings'
    );
  });

  it('does not invent detail routes for unavailable records', () => {
    expect(auditTargetHref({ kind: 'system', id: 'job-1', displayName: 'Job' })).toBeUndefined();
    expect(auditTargetHref({ kind: 'settings', id: 'job-1', displayName: 'Job' })).toBeUndefined();
    expect(auditTargetHref({ kind: 'user', id: '', displayName: 'Erased user' })).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { isSensitivePermission, SENSITIVE_ROLE_PERMISSIONS } from './roleModel';

describe('roleModel sensitive permissions', () => {
  it('flags exactly the data and identity permissions', () => {
    expect([...SENSITIVE_ROLE_PERMISSIONS].sort()).toEqual(['users:delete', 'users:export', 'users:impersonate']);
    for (const id of SENSITIVE_ROLE_PERMISSIONS) expect(isSensitivePermission(id)).toBe(true);
    expect(isSensitivePermission('support:read')).toBe(false);
  });
});

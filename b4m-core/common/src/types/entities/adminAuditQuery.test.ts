import { describe, expect, it } from 'vitest';
import { ADMIN_AUDIT_CATALOGUE } from './adminAuditCatalogue';
import { AuditLogFiltersSchema } from './adminAuditQuery';

describe('AuditLogFiltersSchema', () => {
  it('rejects an unknown category and a non-ISO from', () => {
    expect(AuditLogFiltersSchema.safeParse({ category: 'nope' }).success).toBe(false);
    expect(AuditLogFiltersSchema.safeParse({ from: 'yesterday' }).success).toBe(false);
  });

  it('accepts an empty object', () => {
    expect(AuditLogFiltersSchema.safeParse({}).success).toBe(true);
  });
});

describe('catalogue', () => {
  it('has audit.exported as support/info/bestEffort', () => {
    expect(ADMIN_AUDIT_CATALOGUE['audit.exported']).toEqual({
      category: 'support',
      severity: 'info',
      write: 'bestEffort',
    });
  });
});

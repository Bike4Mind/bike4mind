import { describe, expect, it } from 'vitest';
import { AuditLogFiltersSchema } from '@bike4mind/common';
import { AUDIT_SAVED_VIEWS } from './auditSavedViews';

describe('AUDIT_SAVED_VIEWS', () => {
  it('keys are unique and every filter parses with AuditLogFiltersSchema', () => {
    const keys = AUDIT_SAVED_VIEWS.map(view => view.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const view of AUDIT_SAVED_VIEWS) {
      expect(AuditLogFiltersSchema.safeParse(view.filters).success).toBe(true);
    }
  });
});

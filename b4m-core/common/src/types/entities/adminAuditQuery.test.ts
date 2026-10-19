import { describe, expect, it } from 'vitest';
import { ADMIN_AUDIT_CATALOGUE } from './adminAuditCatalogue';
import { AuditLogFiltersSchema, decodeAuditCursor, encodeAuditCursor } from './adminAuditQuery';

const OBJECT_ID = '671000000000000000000024';
const encodeRaw = (raw: string) => Buffer.from(raw, 'utf8').toString('base64url');

describe('audit cursor codec', () => {
  it('encode/decode round-trips occurredAt and id', () => {
    const cursor = { occurredAt: new Date('2026-10-19T00:00:00.000Z'), id: OBJECT_ID };
    expect(decodeAuditCursor(encodeAuditCursor(cursor))).toEqual(cursor);
  });

  it('decodeAuditCursor rejects garbage, a bad date and a non-ObjectId id', () => {
    expect(decodeAuditCursor('%%%')).toBeNull();
    expect(decodeAuditCursor(encodeRaw(`not-a-date|${OBJECT_ID}`))).toBeNull();
    expect(decodeAuditCursor(encodeRaw('2026-10-19T00:00:00.000Z|abc'))).toBeNull();
  });
});

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

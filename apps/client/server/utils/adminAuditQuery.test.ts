import { describe, expect, it } from 'vitest';
import { decodeAuditCursor, encodeAuditCursor } from './adminAuditQuery';

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

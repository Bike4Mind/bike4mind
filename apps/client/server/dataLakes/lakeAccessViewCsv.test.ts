import { describe, it, expect } from 'vitest';
import type { LakeAccessView } from '@bike4mind/common';
import { lakeAccessViewToCsv, lakeAccessViewCsvFilename } from './lakeAccessViewCsv';

const baseView = (over: Partial<LakeAccessView> = {}): LakeAccessView => ({
  lakeId: 'lake1',
  lakeName: 'Sales Intelligence',
  grants: [],
  channels: [],
  history: [],
  historyTruncated: false,
  generatedAt: new Date('2026-08-14T12:00:00.000Z'),
  ...over,
});

describe('lakeAccessViewToCsv', () => {
  it('emits three labeled sections with headers', () => {
    const csv = lakeAccessViewToCsv(baseView());
    expect(csv).toContain('# Members and grants');
    expect(csv).toContain('# Access channels');
    expect(csv).toContain('# Access history');
    expect(csv).toContain('principalType,principalId,principalName,role,status');
  });

  it('renders a grant row with ISO dates and blank for a null expiry', () => {
    const csv = lakeAccessViewToCsv(
      baseView({
        grants: [
          {
            principalType: 'user',
            principalId: 'u1',
            principalName: 'Alice',
            role: 'reader',
            grantedByUserId: 'owner1',
            grantedByName: 'Olivia',
            grantedAt: new Date('2026-08-01T00:00:00.000Z'),
            expiresAt: null,
            status: 'active',
          },
        ],
      })
    );
    expect(csv).toContain('user,u1,Alice,reader,active,owner1,Olivia,2026-08-01T00:00:00.000Z,');
  });

  it('escapes commas and quotes per RFC-4180', () => {
    const csv = lakeAccessViewToCsv(
      baseView({
        grants: [
          {
            principalType: 'user',
            principalId: 'u1',
            principalName: 'Doe, "Jane"',
            role: 'curator',
            grantedByUserId: 'o',
            grantedByName: undefined,
            grantedAt: new Date('2026-08-01T00:00:00.000Z'),
            expiresAt: null,
            status: 'active',
          },
        ],
      })
    );
    expect(csv).toContain('"Doe, ""Jane"""');
  });

  it('leaves an uncounted channel holderCount blank (never 0), but writes a real count', () => {
    const csv = lakeAccessViewToCsv(
      baseView({
        channels: [
          { kind: 'tag', value: 'vip' },
          { kind: 'organization', value: 'orgA', label: 'Acme', holderCount: 12 },
        ],
      })
    );
    expect(csv).toContain('tag,vip,,'); // no label, no count
    expect(csv).toContain('organization,orgA,Acme,12');
  });

  it('joins history surfaces with a semicolon (not a comma, which would split the field)', () => {
    const csv = lakeAccessViewToCsv(
      baseView({
        history: [
          {
            principalKind: 'user',
            principalId: 'u2',
            principalName: 'Bob',
            readCount: 5,
            firstAccessedAt: new Date('2026-08-01T00:00:00.000Z'),
            lastAccessedAt: new Date('2026-08-10T00:00:00.000Z'),
            surfaces: ['chat-kb-search', 'data-lake-semantic-search'],
          },
        ],
      })
    );
    expect(csv).toContain('chat-kb-search;data-lake-semantic-search');
  });

  it('adds a truncation note only when the history was capped', () => {
    expect(lakeAccessViewToCsv(baseView({ historyTruncated: true }))).toContain('# NOTE: access history was truncated');
    expect(lakeAccessViewToCsv(baseView({ historyTruncated: false }))).not.toContain('truncated');
  });

  it('names the export file after the lake id', () => {
    expect(lakeAccessViewCsvFilename({ lakeId: 'abc123' })).toBe('lake-access-abc123.csv');
  });
});

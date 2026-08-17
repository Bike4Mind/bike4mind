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
    // Every field is quoted (shared escapeCsvCell), headers included.
    expect(csv).toContain('"principalType","principalId","principalName","role","status"');
  });

  it('renders a grant row with ISO dates and an empty quoted field for a null expiry', () => {
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
    expect(csv).toContain('"user","u1","Alice","reader","active","owner1","Olivia","2026-08-01T00:00:00.000Z",""');
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

  it('defuses spreadsheet formula injection in user-controlled names', () => {
    const csv = lakeAccessViewToCsv(
      baseView({
        grants: [
          {
            principalType: 'user',
            principalId: 'u1',
            principalName: '=cmd|/c calc',
            role: 'reader',
            grantedByUserId: 'o',
            grantedByName: '+SUM(A1:A9)',
            grantedAt: new Date('2026-08-01T00:00:00.000Z'),
            expiresAt: null,
            status: 'active',
          },
        ],
      })
    );
    // A leading =, +, -, @ or tab is prefixed with an apostrophe so a spreadsheet does not execute it.
    expect(csv).toContain(`"'=cmd|/c calc"`);
    expect(csv).toContain(`"'+SUM(A1:A9)"`);
    expect(csv).not.toContain('"=cmd|/c calc"');
  });

  it('cannot be made to inject rows or corrupt structure via a hostile lake name', () => {
    const csv = lakeAccessViewToCsv(baseView({ lakeName: 'Evil\r\n1,2,3,injected,row', lakeId: 'lake1' }));
    // Newlines in the name are flattened inside a single quoted field, so no extra row appears and
    // the metadata block stays one lakeName line.
    const lines = csv.split('\r\n');
    expect(lines.filter(l => l.startsWith('"lakeName"'))).toHaveLength(1);
    // The injected payload never becomes its own bare (unquoted) row.
    expect(lines.some(l => l.startsWith('1,2,3'))).toBe(false);
  });

  it('leaves an uncounted channel holderCount as an empty field (never 0), but writes a real count', () => {
    const csv = lakeAccessViewToCsv(
      baseView({
        channels: [
          { kind: 'tag', value: 'vip' },
          { kind: 'organization', value: 'orgA', label: 'Acme', holderCount: 12 },
        ],
      })
    );
    expect(csv).toContain('"tag","vip","","","Tag: vip"'); // no resolved label, no count
    expect(csv).toContain('"organization","orgA","Acme","12","Organization: Acme (12 members with access)"');
  });

  it('exports a description matching the screen for every channel kind, not just organization', () => {
    const csv = lakeAccessViewToCsv(
      baseView({ channels: [{ kind: 'public' }, { kind: 'entitlement', value: 'pro' }] })
    );
    // The machine columns stay sparse for these kinds, but the human column is never blank - a
    // reader comparing the file to the modal must not see one row explained and the others empty.
    expect(csv).toContain('"public","","","","Public: everyone across the app"');
    expect(csv).toContain('"entitlement","pro","","","Entitlement: pro"');
  });

  it('singularizes a one-member organization count', () => {
    const csv = lakeAccessViewToCsv(
      baseView({ channels: [{ kind: 'organization', value: 'orgA', label: 'Acme', holderCount: 1 }] })
    );
    expect(csv).toContain('Organization: Acme (1 member with access)');
  });

  it('always qualifies the history section as a lower bound, even when it has rows', () => {
    const populated = lakeAccessViewToCsv(
      baseView({
        history: [
          {
            principalKind: 'user',
            principalId: 'u1',
            readCount: 2,
            firstAccessedAt: new Date('2026-08-01T00:00:00.000Z'),
            lastAccessedAt: new Date('2026-08-02T00:00:00.000Z'),
            surfaces: ['chat-kb-search'],
          },
        ],
      })
    );
    // Emitted for an empty AND a populated section: rows prove reads happened, never that these are
    // all of them, since only instrumented surfaces emit events and events age out on their TTL.
    expect(populated).toContain('# NOTE: covers reads through instrumented retrieval surfaces');
    expect(lakeAccessViewToCsv(baseView({ history: [] }))).toContain(
      'an empty section is not proof that no one read this lake'
    );
  });

  it('notes conjunctive composition only when the channels actually compose', () => {
    const composing = lakeAccessViewToCsv(
      baseView({
        channels: [
          { kind: 'organization', value: 'orgA', label: 'Acme', holderCount: 12 },
          { kind: 'tag', value: 'vip' },
        ],
      })
    );
    expect(composing).toContain('# NOTE: channels compose conjunctively');
    // A single org channel is not a composition (its count is exact), so no note.
    const single = lakeAccessViewToCsv(
      baseView({ channels: [{ kind: 'organization', value: 'orgA', holderCount: 5 }] })
    );
    expect(single).not.toContain('compose conjunctively');
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

  it('qualifies window-scoped aggregates and carries the window start when the history was capped', () => {
    const csv = lakeAccessViewToCsv(
      baseView({ historyTruncated: true, windowStartsAt: new Date('2026-08-01T00:00:00.000Z') })
    );
    expect(csv).toContain('access history truncated to the most recent window');
    expect(csv).toContain('"historyWindowStartsAt","2026-08-01T00:00:00.000Z"');
    expect(csv).toContain('# NOTE: readCount and firstAccessedAt below cover only the truncated window');
  });

  it('adds no truncation signal when the history was not capped', () => {
    expect(lakeAccessViewToCsv(baseView({ historyTruncated: false }))).not.toContain('truncated');
  });

  it('names the export file after the lake id', () => {
    expect(lakeAccessViewCsvFilename({ lakeId: 'abc123' })).toBe('lake-access-abc123.csv');
  });
});

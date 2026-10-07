import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { gradeLakeRagAnswer, loadLakeRagBank, type LakeRagBankRow, type LakeRagCaseKind } from './grade';

const here = fileURLToPath(new URL('.', import.meta.url));

function byId(id: string): LakeRagBankRow {
  const row = loadLakeRagBank().find(candidate => candidate.id === id);
  if (!row) throw new Error(`missing fixture ${id}`);
  return row;
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(fullPath);
    return entry.isFile() && entry.name.endsWith('.md') ? [fullPath] : [];
  });
}

describe('loadLakeRagBank', () => {
  it('has at least ten questions per subject and the required planted cases', () => {
    const rows = loadLakeRagBank();
    const subjects = [...new Set(rows.map(row => row.subject))];
    expect(subjects.length).toBeGreaterThanOrEqual(3);

    for (const subject of subjects) {
      const subjectRows = rows.filter(row => row.subject === subject);
      expect(subjectRows, subject).toHaveLength(10);
      for (const kind of ['stale-same-name', 'stale-different-name', 'absent'] satisfies LakeRagCaseKind[]) {
        expect(subjectRows.filter(row => row.kind === kind).length, `${subject} ${kind}`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('keeps date frontmatter on every markdown corpus document', () => {
    const files = markdownFiles(join(here, 'corpus'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).toMatch(/^---\ndate: \d{4}-\d{2}-\d{2}\n---\n/);
    }
  });
});

describe('gradeLakeRagAnswer', () => {
  it('passes a current fact with an indexed citation', () => {
    const result = gradeLakeRagAnswer(byId('riverNavigation-fact-001'), 'The fog bell sounds every 45 seconds [2].', {
      citationStyle: 'indexed',
      citables: ['other.md', 'riverNavigation/facts.md'],
    });
    expect(result).toMatchObject({
      passed: true,
      answerMatched: true,
      staleValueRejected: true,
      citationMatched: true,
    });
  });

  it('rejects a stale same-name value even when the citation basename matches', () => {
    const result = gradeLakeRagAnswer(byId('riverNavigation-same-001'), 'The safe tow speed is 3.1 knots [1].', {
      citationStyle: 'indexed',
      citables: ['archive/gauge.md'],
    });
    expect(result.passed).toBe(false);
    expect(result.rejectedTokensFound).toEqual(['3.1 knots']);
  });

  it('passes a stale different-name case only with the newer value and source', () => {
    const result = gradeLakeRagAnswer(byId('seedCatalog-diff-001'), 'The current moon melon value is 12 brix [3].', {
      citationStyle: 'indexed',
      citables: ['1888-melon-notes.md', 'facts.md', '1894-melon-notes.md'],
    });
    expect(result.passed).toBe(true);
  });

  it('fails when an indexed citation resolves to the wrong source', () => {
    const result = gradeLakeRagAnswer(byId('textileDyeing-same-001'), 'The madder vat is held at 62 C [1].', {
      citationStyle: 'indexed',
      citables: ['facts.md', 'current/dye-vat.md'],
    });
    expect(result.passed).toBe(false);
    expect(result.citationMatched).toBe(false);
  });

  it('passes an absent case that says the answer is not in the lake', () => {
    const result = gradeLakeRagAnswer(
      byId('observatory-absent-001'),
      'That answer is not in the lake materials provided for the observatory subject.'
    );
    expect(result.passed).toBe(true);
  });
});

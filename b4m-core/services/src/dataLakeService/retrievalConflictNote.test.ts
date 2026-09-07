import { describe, expect, it } from 'vitest';
import { defangRetrievedContent } from './renderRetrievedContentBlock';
import {
  buildRetrievalConflictNote,
  RETRIEVAL_CONFLICT_MAX_CHARS,
  RETRIEVAL_CONFLICT_MAX_IDS,
  type RetrievalPassage,
} from './retrievalConflictNote';

// Fixed so a report is reproducible - the detector takes the year for the same reason.
const NOW_YEAR = 2026;

const passage = (fabFileId: string, text: string): RetrievalPassage => ({ fabFileId, text });
const noteFor = (...passages: RetrievalPassage[]) => buildRetrievalConflictNote(passages, NOW_YEAR);

describe('buildRetrievalConflictNote', () => {
  it('returns empty for no passages', () => {
    expect(noteFor()).toBe('');
  });

  it('returns empty for a single document, even when it contradicts itself', () => {
    expect(noteFor(passage('file-a', 'Uptime is 99.9%.'), passage('file-a', 'Uptime is 95%.'))).toBe('');
  });

  it('ignores a passage with no id, which cannot be attributed', () => {
    expect(noteFor(passage('', 'Uptime is 99.9%.'), passage('file-b', 'Uptime is 95%.'))).toBe('');
  });

  it('returns empty when two documents do not conflict', () => {
    const note = noteFor(
      passage('file-a', 'The onboarding guide covers account setup.'),
      passage('file-b', 'Support hours are listed here.')
    );
    expect(note).toBe('');
  });

  it('names both documents and the kind on a metric disagreement', () => {
    const note = noteFor(passage('file-a', 'Uptime is 99.9%.'), passage('file-b', 'Uptime is 95%.'));
    expect(note).toContain('1 cross-document conflict(s) detected');
    expect(note).toContain('(metric-disagreement: 1)');
    expect(note).toContain('across documents file-a, file-b.');
  });

  it('counts each conflicting subject separately', () => {
    const note = noteFor(
      passage('file-a', 'Uptime is 99.9%.\nLatency is 10 ms.'),
      passage('file-b', 'Uptime is 95%.\nLatency is 40 ms.')
    );
    expect(note).toContain('(metric-disagreement: 2)');
    expect(note).toContain('2 cross-document conflict(s) detected');
  });

  it('reads one unit written two ways as one unit', () => {
    expect(noteFor(passage('file-a', 'Uptime is 99.9%.'), passage('file-b', 'Uptime is 95 percent.'))).toContain(
      'metric-disagreement: 1'
    );
  });

  // Detection runs over the text the site RENDERS, which at two of the three sites is defanged. The
  // defang only indents line-initial markers and the detector trims each sentence it splits out, so
  // the two forms have to detect identically - or a note would depend on which site emitted it.
  it('detects the same conflict before and after the defang pass', () => {
    const a = '### Metrics\nUptime is 99.9%.';
    const b = 'NOTE: revised figures.\nUptime is 95%.';
    const raw = noteFor(passage('file-a', a), passage('file-b', b));
    const defanged = noteFor(
      passage('file-a', defangRetrievedContent(a)),
      passage('file-b', defangRetrievedContent(b))
    );

    expect(raw).toContain('metric-disagreement: 1');
    expect(defanged).toBe(raw);
  });

  /**
   * The kinds this surface deliberately does NOT assert - see DISAGREEMENT_INCONSISTENCY_KINDS. The
   * lake health scan still reports all of them; a note that tells a model "these documents disagree"
   * cannot be built on a rule that fires when they agree.
   */
  describe('kinds that cannot support an assertion of disagreement', () => {
    it('says nothing about two documents carrying the IDENTICAL superlative sentence', () => {
      const sentence = 'The largest data center is in Oregon.';
      expect(noteFor(passage('file-a', sentence), passage('file-b', sentence))).toBe('');
    });

    it('says nothing about a common phrase that only looks exclusive', () => {
      const note = noteFor(
        passage('file-a', 'The first step is to install the CLI.'),
        passage('file-b', 'The first step is to create an organization.')
      );
      expect(note).toBe('');
    });

    it('says nothing about a genuine superlative conflict either, since the rule cannot tell them apart', () => {
      const note = noteFor(
        passage('file-a', 'We are the only ingest engine.'),
        passage('file-b', 'Vendor Two is the only ingest engine.')
      );
      expect(note).toBe('');
    });

    it('says nothing about a relationship conflict, whose subject is a bare capitalization proxy', () => {
      const note = noteFor(
        passage('file-a', 'Northwind Logistics is a customer.'),
        passage('file-b', 'Northwind Logistics remains a prospect.')
      );
      expect(note).toBe('');
    });

    it('says nothing about a repeated capitalized product name in unrelated sentences', () => {
      const note = noteFor(
        passage('file-a', 'Machine Learning Platform is deployed at scale.'),
        passage('file-b', 'Machine Learning Platform is a pilot for the team.')
      );
      expect(note).toBe('');
    });

    it('ignores expired-claim findings, which are staleness rather than disagreement', () => {
      const note = noteFor(passage('file-a', 'Available through 2019.'), passage('file-b', 'Supported through 2018.'));
      expect(note).toBe('');
    });
  });

  /**
   * A unitless number is not a comparable metric. Without the unit requirement every shape below
   * reported a disagreement - two sections of different documents, one label measured over two
   * different scopes, and a per-period series disagreeing with its own next quarter.
   */
  describe('unitless numbers are not metrics', () => {
    it.each([
      ['a section index', 'Section 2 of 5 covers ingest.', 'Section 2 of 9 covers the endpoints.'],
      [
        'the same label over a different scope',
        'The rate limit is 100 requests per minute for tier 1.',
        'The rate limit is 1000 requests per minute for tier 2.',
      ],
      [
        'a unit outside the metric vocabulary',
        'The retention policy is 30 days for logs.',
        'The retention policy is 90 days for audit records.',
      ],
      [
        'a per-period series',
        'Q1 2025 report. Monthly active users: 1,200.',
        'Q2 2025 report. Monthly active users: 1,450.',
      ],
    ])('says nothing about %s', (_label, a, b) => {
      expect(noteFor(passage('file-a', a), passage('file-b', b))).toBe('');
    });

    it('says nothing when the same label is measured in two different units', () => {
      expect(noteFor(passage('file-a', 'Latency is 100 ms.'), passage('file-b', 'Latency is 2 s.'))).toBe('');
    });
  });

  /**
   * Every site cuts a passage to its char budget with a raw `slice`, so the text handed here can end
   * mid-number. A surviving `1,2` must never be read as a claim: the unit follows the value, so a cut
   * that damages the value takes the unit with it and the fragment stops matching as a metric.
   */
  describe('a budget-clipped passage cannot fabricate a conflict', () => {
    const full = 'Intro sentence here. Total revenue is 1,200,000 USD for the fiscal year.';

    it('says nothing when a clip leaves a prefix of the SAME figure the other document states', () => {
      const clipped = `${full.slice(0, 41)}\u2026`;
      expect(clipped).toContain('is 1,2');
      expect(noteFor(passage('file-a', clipped), passage('file-b', full))).toBe('');
    });

    it('says nothing when the clip lands on what looks like a sentence end but is a decimal point', () => {
      const note = noteFor(passage('file-a', 'Latency is 1,200.'), passage('file-b', 'Latency is 1,200.500 ms.'));
      expect(note).toBe('');
    });

    it('still reports the real conflict in a clipped passage, dropping only the fragment', () => {
      const note = noteFor(
        passage('file-a', 'Uptime is 99.9%. Latency is 1,2\u2026'),
        passage('file-b', 'Uptime is 95%. Latency is 1,200 ms.')
      );
      // Uptime disagrees and is complete in both; the clipped latency fragment contributes nothing.
      expect(note).toContain('(metric-disagreement: 1)');
    });
  });

  it('opens with the NOTE marker and ends with a blank line', () => {
    const note = noteFor(passage('file-a', 'Uptime is 99.9%.'), passage('file-b', 'Uptime is 95%.'));
    expect(note.startsWith('NOTE: ')).toBe(true);
    expect(note.endsWith('\n\n')).toBe(true);
  });

  // The note is our own column-0 framing, so nothing derived from document prose may reach it:
  // `subject` is normalized straight out of a sentence and `excerpt` is the sentence itself.
  // `fileName` cannot leak because RetrievalPassage never carries one into the detector.
  it('never emits a subject or an excerpt', () => {
    const sentenceA = 'Zorbulax throughput is 42 ms.';
    const sentenceB = 'Zorbulax throughput is 900 ms.';
    const note = noteFor(passage('file-a', sentenceA), passage('file-b', sentenceB));

    expect(note).not.toBe('');
    expect(note.toLowerCase()).not.toContain('zorbulax');
    expect(note).not.toContain(sentenceA);
    expect(note).not.toContain(sentenceB);
  });

  it('caps the id list and reports the overflow as a lower bound', () => {
    const passages = Array.from({ length: 15 }, (_, i) => passage(`file-${i}`, `Uptime is ${i + 1}%.`));
    const note = buildRetrievalConflictNote(passages, NOW_YEAR);

    expect(note).toContain(`, and at least ${15 - RETRIEVAL_CONFLICT_MAX_IDS} more`);
    expect(note).not.toContain('file-14');
  });

  it('stops reading documents once the char ceiling is reached', () => {
    const note = noteFor(
      passage('file-a', 'x'.repeat(RETRIEVAL_CONFLICT_MAX_CHARS)),
      passage('file-b', 'Uptime is 99.9%.'),
      passage('file-c', 'Uptime is 95%.')
    );
    // Only the first document fit, so there is no second document to disagree with.
    expect(note).toBe('');
  });

  it('reads the part of a document that fits under the char ceiling', () => {
    const note = noteFor(
      passage('file-a', `Uptime is 99.9%. ${'x'.repeat(RETRIEVAL_CONFLICT_MAX_CHARS - 100)}`),
      passage('file-b', `Uptime is 95%. ${'y'.repeat(200)}`)
    );
    // The second document overran the ceiling and was sliced, keeping its opening claim.
    expect(note).toContain('(metric-disagreement: 1)');
  });
});

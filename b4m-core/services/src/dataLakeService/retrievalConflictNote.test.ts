import { describe, expect, it } from 'vitest';
import {
  buildRetrievalConflictNote,
  RETRIEVAL_CONFLICT_MAX_CHARS,
  RETRIEVAL_CONFLICT_MAX_IDS,
  type RetrievalPassage,
} from './retrievalConflictNote';

// Fixed so a report is reproducible - the detector takes the year for the same reason.
const NOW_YEAR = 2026;

const passage = (fabFileId: string, text: string): RetrievalPassage => ({ fabFileId, text });

describe('buildRetrievalConflictNote', () => {
  it('returns empty for no passages', () => {
    expect(buildRetrievalConflictNote([], NOW_YEAR)).toBe('');
  });

  it('returns empty for a single document, even when it contradicts itself', () => {
    const note = buildRetrievalConflictNote(
      [passage('file-a', 'Uptime is 99.9%.'), passage('file-a', 'Uptime is 95%.')],
      NOW_YEAR
    );
    expect(note).toBe('');
  });

  it('returns empty when two documents do not conflict', () => {
    const note = buildRetrievalConflictNote(
      [
        passage('file-a', 'The onboarding guide covers account setup.'),
        passage('file-b', 'Support hours are listed here.'),
      ],
      NOW_YEAR
    );
    expect(note).toBe('');
  });

  it('names both documents and the kind on a metric disagreement', () => {
    const note = buildRetrievalConflictNote(
      [passage('file-a', 'Uptime is 99.9%.'), passage('file-b', 'Uptime is 95%.')],
      NOW_YEAR
    );
    expect(note).toContain('1 cross-document conflict(s) detected');
    expect(note).toContain('metric-disagreement: 1');
    expect(note).toContain('file-a');
    expect(note).toContain('file-b');
  });

  it('fires on a superlative conflict', () => {
    const note = buildRetrievalConflictNote(
      [passage('file-a', 'We are the only ingest engine.'), passage('file-b', 'Vendor Two is the only ingest engine.')],
      NOW_YEAR
    );
    expect(note).toContain('superlative-conflict: 1');
  });

  it('fires on a relationship conflict', () => {
    const note = buildRetrievalConflictNote(
      [
        passage('file-a', 'Northwind Logistics is a customer.'),
        passage('file-b', 'Northwind Logistics remains a prospect.'),
      ],
      NOW_YEAR
    );
    expect(note).toContain('relationship-conflict: 1');
  });

  it('orders the count terms by RETRIEVAL_CONFLICT_KINDS, not by finding order', () => {
    const note = buildRetrievalConflictNote(
      [
        passage('file-a', 'Uptime is 99.9%.\nWe are the only ingest engine.'),
        passage('file-b', 'Uptime is 95%.\nVendor Two is the only ingest engine.'),
      ],
      NOW_YEAR
    );
    expect(note).toContain('(superlative-conflict: 1, metric-disagreement: 1)');
    expect(note).toContain('2 cross-document conflict(s) detected');
  });

  it('ignores expired-claim findings', () => {
    const note = buildRetrievalConflictNote(
      [passage('file-a', 'Available through 2019.'), passage('file-b', 'Supported through 2018.')],
      NOW_YEAR
    );
    expect(note).toBe('');
  });

  it('opens with the NOTE marker and ends with a blank line', () => {
    const note = buildRetrievalConflictNote(
      [passage('file-a', 'Uptime is 99.9%.'), passage('file-b', 'Uptime is 95%.')],
      NOW_YEAR
    );
    expect(note.startsWith('NOTE: ')).toBe(true);
    expect(note.endsWith('\n\n')).toBe(true);
  });

  // The note is our own column-0 framing, so nothing derived from document prose may reach it:
  // `subject` is normalized straight out of a sentence and `excerpt` is the sentence itself.
  // `fileName` cannot leak because RetrievalPassage never carries one into the detector.
  it('never emits a subject or an excerpt', () => {
    const sentenceA = 'Zorbulax throughput is 42 ms.';
    const sentenceB = 'Zorbulax throughput is 900 ms.';
    const note = buildRetrievalConflictNote([passage('file-a', sentenceA), passage('file-b', sentenceB)], NOW_YEAR);

    expect(note).not.toBe('');
    expect(note.toLowerCase()).not.toContain('zorbulax');
    expect(note).not.toContain(sentenceA);
    expect(note).not.toContain(sentenceB);
  });

  it('caps the id list and reports the overflow', () => {
    const passages = Array.from({ length: 15 }, (_, i) => passage(`file-${i}`, `Uptime is ${i + 1}%.`));
    const note = buildRetrievalConflictNote(passages, NOW_YEAR);

    expect(note).toContain(`, and ${15 - RETRIEVAL_CONFLICT_MAX_IDS} more`);
    expect(note).not.toContain('file-14');
  });

  it('stops reading documents once the char ceiling is reached', () => {
    const note = buildRetrievalConflictNote(
      [
        passage('file-a', 'x'.repeat(RETRIEVAL_CONFLICT_MAX_CHARS)),
        passage('file-b', 'Uptime is 99.9%.'),
        passage('file-c', 'Uptime is 95%.'),
      ],
      NOW_YEAR
    );
    // Only the first document fit, so there is no second document to disagree with.
    expect(note).toBe('');
  });
});

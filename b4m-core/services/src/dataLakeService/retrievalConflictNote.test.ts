import { detectCorpusInconsistencies } from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import { defangRetrievedContent } from './renderRetrievedContentBlock';
import {
  ALL_DATED_CLAIMS_EXPIRED_YEAR,
  buildRetrievalConflictNote,
  RETRIEVAL_CONFLICT_MAX_CHARS,
  type RetrievalPassage,
} from './retrievalConflictNote';

const passage = (fabFileId: string, text: string): RetrievalPassage => ({ fabFileId, text });
const noteFor = (...passages: RetrievalPassage[]) => buildRetrievalConflictNote(passages);

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

  /**
   * The note ASSERTS that the documents it names disagree, so a document whose claims all match its
   * sibling's must never be named. A passage set where one document states both figures is the
   * ordinary case on the always-on channel, which pools several chunks per file.
   */
  it('says nothing about two documents that each state both figures', () => {
    const both = 'Uptime is 99.9%. Uptime is 95%.';
    expect(noteFor(passage('file-a', both), passage('file-b', both))).toBe('');
  });

  it('names both documents when one states both figures and the other only one of them', () => {
    // A real disagreement: file-b's only figure contradicts one of file-a's.
    const note = noteFor(passage('file-a', 'Uptime is 99.9%. Uptime is 95%.'), passage('file-b', 'Uptime is 95%.'));
    expect(note).toContain('across documents file-a, file-b.');
  });

  it('names both documents and the kind on a metric disagreement', () => {
    const note = noteFor(passage('file-a', 'Uptime is 99.9%.'), passage('file-b', 'Uptime is 95%.'));
    expect(note).toContain('1 cross-document conflict detected');
    expect(note).toContain('(metric-disagreement)');
    expect(note).toContain('across documents file-a, file-b.');
  });

  it('counts each conflicting subject separately', () => {
    const note = noteFor(
      passage('file-a', 'Uptime is 99.9%.\nLatency is 10 ms.'),
      passage('file-b', 'Uptime is 95%.\nLatency is 40 ms.')
    );
    // One kind, so the per-kind count would restate the headline count: named without it.
    expect(note).toContain('2 cross-document conflicts detected (metric-disagreement)');
    // Two findings, each naming both documents. Undeduped this reads `file-a, file-b, file-a,
    // file-b`, and past the id cap the overflow arithmetic then invents documents that do not exist.
    expect(note).toContain('across documents file-a, file-b.');
  });

  it('does not count a document once per finding when computing the overflow', () => {
    // Six conflicting subjects over the same two documents: twelve evidence entries, two documents.
    // Undeduped the id list fills to the cap of ten and claims "at least 2 more" for a two-document
    // corpus - our own framing telling the model to look for passages that were never retrieved.
    const subjects = ['uptime', 'latency', 'margin', 'coverage', 'throughput', 'error rate'];
    const note = noteFor(
      passage('file-a', subjects.map(s => `The ${s} is 10%.`).join('\n')),
      passage('file-b', subjects.map(s => `The ${s} is 90%.`).join('\n'))
    );

    expect(note).toContain('6 cross-document conflicts detected (metric-disagreement)');
    expect(note).toContain('across documents file-a, file-b.');
    expect(note).not.toContain('more');
  });

  it('reads one unit written two ways as one unit', () => {
    expect(noteFor(passage('file-a', 'Uptime is 99.9%.'), passage('file-b', 'Uptime is 95 percent.'))).toContain(
      'metric-disagreement'
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

    expect(raw).toContain('metric-disagreement');
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

    // One YEAR across both documents, so the detector returns a single expired-claim finding
    // spanning two documents. Two different years would each span one and be dropped by the
    // `documentCount` guard instead, leaving the kind filter untested.
    it('ignores expired-claim findings, which are staleness rather than disagreement', () => {
      const note = noteFor(passage('file-a', 'Available through 2099.'), passage('file-b', 'Supported through 2099.'));
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
      expect(note).toContain('(metric-disagreement)');
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

  it('counts only the asserted findings, not every finding the detector returned', () => {
    // The repeated superlative sentence is a second finding the detector returns and this surface
    // drops, so a count taken from `findings` would claim two conflicts and name one kind.
    const note = noteFor(
      passage('file-a', 'Uptime is 99.9%.\nThe largest data center is in Oregon.'),
      passage('file-b', 'Uptime is 95%.\nThe largest data center is in Oregon.')
    );
    expect(note).toContain('1 cross-document conflict detected (metric-disagreement)');
  });

  // Six unrelated conflicts, one witness pair each: twelve ids past a cap of ten. A single subject
  // cannot get there any more - the note names the pair that witnesses a conflict, not every
  // document that mentions its subject - so breadth now comes from separate conflicts.
  const disjointConflicts = (count: number) =>
    Array.from({ length: count }, (_, i) => [
      passage(`file-${2 * i}`, `The metric${i} is 10%.`),
      passage(`file-${2 * i + 1}`, `The metric${i} is 90%.`),
    ]).flat();

  it('caps the id list and reports the overflow as a lower bound', () => {
    const note = buildRetrievalConflictNote(disjointConflicts(6));

    // Literals, not the constant: an assertion computed from RETRIEVAL_CONFLICT_MAX_IDS moves with it
    // and holds at any cap. Ids come out in serve order, so file-9/file-10 is the boundary.
    expect(note).toContain(', and at least 2 more');
    expect(note).toContain('file-9,');
    expect(note).not.toContain('file-10');
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

  it('sweeps only the part of a document that fits, not the whole of it', () => {
    // The last document to fit is sliced rather than dropped, so a claim past the ceiling is not
    // swept - and a note naming it would rest on text this call never even read.
    const note = noteFor(
      passage('file-a', 'Uptime is 99.9%.'),
      passage('file-b', `${'padding text. '.repeat(RETRIEVAL_CONFLICT_MAX_CHARS / 10)}Uptime is 95%.`)
    );
    expect(note).toBe('');
  });

  it('names the two documents that witness a conflict, not the ones that merely share its subject', () => {
    // Three documents, one conflict: file-c contradicts the other two, which agree. Naming all
    // three reads as three mutually contradicting figures - the ordinary shape in a real corpus,
    // and the one the model has the least reason to doubt. file-b is left out of the claim, not
    // out of the block: it is still there to read.
    const note = noteFor(
      passage('file-a', 'Uptime is 99.9%.'),
      passage('file-b', 'Uptime is 99.9%.'),
      passage('file-c', 'Uptime is 95%.')
    );
    expect(note).toContain('1 cross-document conflict detected');
    expect(note).toContain('across documents file-a, file-c.');
    expect(note).not.toContain('file-b');
  });

  it('names the documents in the order the channel serves them', () => {
    // Evidence comes out witness-pair-first, so without a re-sort the note names a lower-ranked
    // passage before a higher-ranked one and the model reads the list against nothing. file-c
    // leads the raw evidence here because it is the dissenter that witnesses the conflict.
    const note = noteFor(
      passage('file-a', 'Uptime is 95%.'),
      passage('file-b', 'Uptime is 99.9%.'),
      passage('file-c', 'Uptime is 99.9%.')
    );
    expect(note).toContain('across documents file-a, file-b.');
    expect(note).not.toContain('file-b, file-a');
  });

  it('groups the documents per conflict when two conflicts share no document', () => {
    // Flattened, this reads as one list of four documents that all disagree with each other. Only
    // file-a/file-b and file-c/file-d are actually in conflict, and the pairs are unrelated.
    const note = noteFor(
      passage('file-a', 'Uptime is 99.9%.'),
      passage('file-b', 'Uptime is 95%.'),
      passage('file-c', 'Latency is 10 ms.'),
      passage('file-d', 'Latency is 40 ms.')
    );
    expect(note).toContain('2 cross-document conflicts detected');
    expect(note).toContain('across documents (file-a, file-b) and (file-c, file-d).');
  });

  it('states one flat list when both conflicts span the same documents', () => {
    // Six subjects over one pair is one relationship to state, not six identical groups.
    const subjects = ['uptime', 'latency', 'margin'];
    const note = noteFor(
      passage('file-a', subjects.map(s => `The ${s} is 10%.`).join('\n')),
      passage('file-b', subjects.map(s => `The ${s} is 90%.`).join('\n'))
    );
    expect(note).toContain('across documents file-a, file-b.');
    expect(note).not.toContain('(file-a');
  });

  it('names exactly the cap without claiming an overflow', () => {
    // The boundary the overflow fixture steps past: at exactly the cap `overflow` is 0, and an
    // `overflow >= 0` comparison would render "and at least 0 more" here.
    const note = buildRetrievalConflictNote(disjointConflicts(5));

    expect(note).toContain('file-9)');
    expect(note).not.toContain('more');
  });

  // The figure has to be compared as a number. `99.90%` in a table against `99.9%` in prose is
  // ordinary in a curated corpus, and asserting it to the model as a contradiction is a formatting
  // difference dressed up as a numeric one. Pinned upstream too; here because this is the surface
  // that ASSERTS it.
  it('says nothing about the same figure written with a trailing zero', () => {
    expect(noteFor(passage('file-a', 'Uptime is 99.90%.'), passage('file-b', 'Uptime is 99.9%.'))).toBe('');
  });

  /**
   * The note's whole deliverable: a hedge, so the model does not treat a heuristic match as proven,
   * and the instruction to surface the disagreement instead of picking a side. Everything else
   * asserted about the note is its frame - marker, count, kind, ids - all of which survives deleting
   * this prose entirely, and three of these clauses are review-directed wording that would otherwise
   * revert green.
   */
  it('carries the hedge and the instruction the note exists to deliver', () => {
    const note = noteFor(passage('file-a', 'Uptime is 99.9%.'), passage('file-b', 'Uptime is 95%.'));

    expect(note).toContain('heuristic pattern matches over the passage text, not proven contradictions');
    expect(note).toContain('the same label can be measured over a different scope in each document');
    expect(note).toContain('say so rather than silently picking one side');
    expect(note).toContain('attribute each conflicting claim to the document it came from');
    // Deferred rather than named, so the note does not fight a channel that cites by bracketed index.
    expect(note).toContain('whatever citation style this context already specifies');
  });

  // The literal keeps this surface off the clock, and it is past DATED_CLAIM's own range so every
  // dated claim reads as expired - which is what keeps the kind filter's expired-claim arm live. A
  // past year would be equally inert by producing no such finding at all, and the test above that
  // pins the filter would then pass whatever the filter did.
  it('reads every dated claim as expired, so the kind filter is exercised rather than vacuous', () => {
    const documents = [
      { fabFileId: 'file-a', text: 'Available through 2099.' },
      { fabFileId: 'file-b', text: 'Supported through 2099.' },
    ];
    const findings = detectCorpusInconsistencies(documents, {
      nowYear: ALL_DATED_CLAIMS_EXPIRED_YEAR,
      metricUnitRequired: true,
    }).findings;

    expect(findings.map(f => f.kind)).toEqual(['expired-claim']);
    expect(findings[0].documentCount).toBe(2);
  });

  it('reads the part of a document that fits under the char ceiling', () => {
    const note = noteFor(
      passage('file-a', `Uptime is 99.9%. ${'x'.repeat(RETRIEVAL_CONFLICT_MAX_CHARS - 100)}`),
      passage('file-b', `Uptime is 95%. ${'y'.repeat(200)}`)
    );
    // The second document overran the ceiling and was sliced, keeping its opening claim.
    expect(note).toContain('(metric-disagreement)');
  });
});

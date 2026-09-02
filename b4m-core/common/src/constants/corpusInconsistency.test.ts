import { describe, it, expect } from 'vitest';
import { detectCorpusInconsistencies, type CorpusDocument } from './corpusInconsistency';

const doc = (fabFileId: string, text: string, fileName = `${fabFileId}.pdf`): CorpusDocument => ({
  fabFileId,
  fileName,
  text,
});

const run = (documents: CorpusDocument[], nowYear = 2026) => detectCorpusInconsistencies(documents, { nowYear });
const kinds = (documents: CorpusDocument[], nowYear = 2026) => run(documents, nowYear).findings.map(f => f.kind);

describe('superlative conflicts', () => {
  it('flags two documents each claiming exclusivity over the same category', () => {
    const report = run([
      doc('a', 'Our platform is the fastest ingest pipeline on the market.'),
      doc('b', 'This product is the fastest ingest pipeline available anywhere.'),
    ]);

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].kind).toBe('superlative-conflict');
    expect(report.findings[0].evidence.map(e => e.fabFileId).sort()).toEqual(['a', 'b']);
  });

  it('does not flag one document restating its own claim', () => {
    // The cross-document requirement. A single file repeating itself across sections is not an
    // inconsistency, and flagging it would bury the real findings under a document's own structure.
    expect(kinds([doc('a', 'We are the fastest ingest pipeline. Truly the fastest ingest pipeline.')])).toEqual([]);
  });

  it('carries one excerpt per document, not one per matching sentence', () => {
    const report = run([
      doc('a', 'The best data platform. Again, the best data platform. And the best data platform.'),
      doc('b', 'Theirs is the best data platform.'),
    ]);

    expect(report.findings[0].evidence).toHaveLength(2);
  });

  it('ignores comparatives, which two documents can both hold without contradiction', () => {
    expect(
      kinds([doc('a', 'Our pipeline is faster than the alternatives.'), doc('b', 'Their pipeline is faster too.')])
    ).toEqual([]);
  });
});

describe('metric disagreements', () => {
  it('flags one metric stated at two values across documents', () => {
    const report = run([doc('a', 'Uptime is 99.9%'), doc('b', 'Uptime is 99.5%')]);

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].kind).toBe('metric-disagreement');
  });

  it('does NOT flag two documents quoting the same figure', () => {
    // Agreement is not a finding. A rule that groups by label alone reports every metric the corpus
    // states twice, which is most of them, and the signal becomes unreadable.
    expect(kinds([doc('a', 'Uptime is 99.9%'), doc('b', 'Uptime is 99.9%')])).toEqual([]);
  });

  it('treats a thousands separator as the same number', () => {
    expect(kinds([doc('a', 'Throughput is 1,200 ms'), doc('b', 'Throughput is 1200 ms')])).toEqual([]);
  });

  it('does not flag a metric stated in only one document', () => {
    expect(kinds([doc('a', 'Latency is 40 ms'), doc('b', 'Nothing quantitative here.')])).toEqual([]);
  });
});

describe('relationship conflicts', () => {
  it('flags an organization called a customer in one document and a prospect in another', () => {
    const report = run([
      doc('a', 'Northwind Logistics is a customer running in production.'),
      doc('b', 'Northwind Logistics is a prospect currently evaluating the platform.'),
    ]);

    const finding = report.findings.find(f => f.kind === 'relationship-conflict');
    expect(finding).toBeDefined();
    expect(finding?.evidence.map(e => e.fabFileId).sort()).toEqual(['a', 'b']);
  });

  it('ignores a sentence carrying both labels, which describes a transition', () => {
    // "a prospect that became a customer" is a history, not a contradiction. Without this the rule
    // fires on exactly the sentences written to explain the relationship.
    //
    // Document `b` carries a SINGLE label on purpose. With both documents holding the both-label
    // sentence this test passed with the guard deleted: the sentence yields `customer` for both, so
    // `distinguish` saw one distinct label and dropped the group anyway. A differing single-label
    // sibling is what makes the guard load-bearing - remove it and the pair conflicts.
    expect(
      kinds([
        doc('a', 'Northwind Logistics is a prospect that became a customer last year.'),
        doc('b', 'Northwind Logistics is a prospect.'),
      ])
    ).toEqual([]);
  });

  it('does not flag consistent labelling across documents', () => {
    expect(
      kinds([doc('a', 'Northwind Logistics is a customer.'), doc('b', 'Northwind Logistics is a customer of ours.')])
    ).toEqual([]);
  });
});

describe('expired claims', () => {
  it('flags a dated claim whose year has passed', () => {
    const report = run([doc('a', 'General availability is expected in 2024.')], 2026);

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].kind).toBe('expired-claim');
    expect(report.findings[0].subject).toBe('2024');
  });

  it('does not flag a claim still in the future, or the current year', () => {
    expect(kinds([doc('a', 'Available through 2027.')], 2026)).toEqual([]);
    expect(kinds([doc('a', 'Available through 2026.')], 2026)).toEqual([]);
  });

  it('is single-document by design, unlike the cross-document rules', () => {
    // This one contradicts the calendar rather than a sibling, so it must fire on one file alone.
    const report = run([doc('solo', 'Supported until 2020.')], 2026);

    expect(report.findings[0].evidence).toHaveLength(1);
  });

  it('groups by year across the corpus rather than emitting one finding per sentence', () => {
    // The volume driver behind the P1. One boilerplate line repeated across a corpus is one fact
    // about that corpus, not N findings, and as N findings it starved every other kind out of the
    // stored cap.
    const documents = Array.from({ length: 30 }, (_, i) => doc(`d${i}`, 'Supported until 2020.'));
    const report = run(documents, 2026);

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].subject).toBe('2020');
    expect(report.findings[0].documentCount).toBe(30);
  });

  it('does not fire on a retrospective statement of fact', () => {
    // "Revenue grew through 2024" is permanently true. The bare through/until form could not tell a
    // commitment from a historical narrative, and historical narrative is among the most common
    // shapes in a curated corpus - so most of what this rule emitted was noise.
    expect(kinds([doc('a', 'Revenue grew through 2024.')], 2026)).toEqual([]);
    expect(kinds([doc('a', 'Data was collected through 2019.')], 2026)).toEqual([]);
    // Still fires on the forward-looking forms, which are the claims that actually expire.
    expect(kinds([doc('a', 'Supported until 2020.')], 2026)).toEqual(['expired-claim']);
    expect(kinds([doc('a', 'GA in 2021.')], 2026)).toEqual(['expired-claim']);
  });

  it('reads the year from the caller, not the clock, so a report is reproducible', () => {
    expect(kinds([doc('a', 'Expected in 2025.')], 2024)).toEqual([]);
    expect(kinds([doc('a', 'Expected in 2025.')], 2026)).toEqual(['expired-claim']);
  });
});

describe('report shape', () => {
  it('counts by kind over ALL findings even when the list is capped', () => {
    const report = detectCorpusInconsistencies(
      [doc('a', 'Supported until 2001. Supported until 2002. Supported until 2003.')],
      { nowYear: 2026, maxFindings: 1 }
    );

    expect(report.findings).toHaveLength(1);
    expect(report.countsByKind['expired-claim']).toBe(3);
  });

  it('is stable across runs over unchanged content', () => {
    const build = () => [
      doc('a', 'Uptime is 99.9%. Northwind Corp is a customer.'),
      doc('b', 'Uptime is 99.5%. Northwind Corp is a prospect evaluating us.'),
    ];

    expect(JSON.stringify(run(build()).findings)).toBe(JSON.stringify(run(build()).findings));
  });

  it('passes `sampled` through so counts read as a lower bound', () => {
    expect(detectCorpusInconsistencies([], { nowYear: 2026, sampled: true }).sampled).toBe(true);
    expect(detectCorpusInconsistencies([], { nowYear: 2026 }).sampled).toBe(false);
  });

  it('never lets one prolific kind evict every other kind from a capped list', () => {
    // The P1. expired-claim used to emit one finding per sentence per document, kinds sort
    // alphabetically with expired-claim first, and the cap was a slice applied after that sort - so
    // one boilerplate footer across a sampled corpus filled the cap and discarded every genuine
    // cross-document finding the feature exists to produce. Measured: 220 in, 200 stored, all 20
    // cross-document ones gone.
    const documents = [
      ...Array.from({ length: 60 }, (_, i) => doc(`e${i}`, `Supported until ${2000 + i}. Uptime is 99.9%.`)),
      doc('m', 'Uptime is 12.5%. Latency is 40 ms.'),
      doc('n', 'Latency is 900 ms.'),
    ];

    const report = detectCorpusInconsistencies(documents, { nowYear: 2026, maxFindings: 10 });
    const stored = new Set(report.findings.map(f => f.kind));

    expect(report.findings).toHaveLength(10);
    expect(stored.has('metric-disagreement')).toBe(true);
    expect(stored.has('expired-claim')).toBe(true);
    expect(report.truncated).toBe(true);
  });

  it('spends the whole budget when only one kind is present', () => {
    // The round-robin must not under-fill: a lane running out is not a reason to leave budget unspent.
    const documents = Array.from({ length: 12 }, (_, i) => doc(`e${i}`, `Supported until ${2000 + i}.`));
    const report = detectCorpusInconsistencies(documents, { nowYear: 2026, maxFindings: 5 });

    expect(report.findings).toHaveLength(5);
    expect(report.findings.every(f => f.kind === 'expired-claim')).toBe(true);
  });

  it('reports truncated only when the cap actually dropped something', () => {
    const documents = [doc('a', 'Uptime is 99.9%'), doc('b', 'Uptime is 99.5%')];

    expect(detectCorpusInconsistencies(documents, { nowYear: 2026, maxFindings: 50 }).truncated).toBe(false);
    expect(detectCorpusInconsistencies(documents, { nowYear: 2026 }).truncated).toBe(false);
  });

  it('bounds evidence per finding while keeping the true document count', () => {
    // A count cap on findings is not a byte cap: evidence carries one entry per document, so a
    // subject shared across a large sample put that many excerpts in a SINGLE finding - measured at
    // ~11.8 MB for one report, against MongoDB's 16 MB ceiling, on the lake document itself.
    const documents = Array.from({ length: 40 }, (_, i) => doc(`d${i}`, `Uptime is ${90 + i}.5%`));
    const report = detectCorpusInconsistencies(documents, { nowYear: 2026 });
    const finding = report.findings.find(f => f.kind === 'metric-disagreement');

    expect(finding?.evidence.length).toBe(20);
    expect(finding?.documentCount).toBe(40);
  });

  it('reports nothing for an empty corpus, and nothing for prose with no claims', () => {
    expect(run([]).findings).toEqual([]);
    expect(kinds([doc('a', 'This document describes a process in general terms.')])).toEqual([]);
  });

  it('quotes the sentence that produced each finding, so a reader can judge it', () => {
    const report = run([doc('a', 'Uptime is 99.9%'), doc('b', 'Uptime is 99.5%')]);

    expect(report.findings[0].evidence[0].excerpt).toContain('99.9');
    expect(report.findings[0].evidence[0].fileName).toBe('a.pdf');
  });

  it('bounds an excerpt so one long paragraph cannot dominate the payload', () => {
    const long = `Uptime is 99.9% ${'and here is a great deal more prose '.repeat(40)}`;
    const report = run([doc('a', long), doc('b', 'Uptime is 99.5%')]);

    const excerpt = report.findings[0].evidence.find(e => e.fabFileId === 'a')?.excerpt ?? '';
    expect(excerpt.length).toBeLessThanOrEqual(240);
    expect(excerpt.endsWith('...')).toBe(true);
  });
});

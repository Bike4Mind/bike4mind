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

describe('metric disagreements with unitRequired', () => {
  const unitKinds = (documents: CorpusDocument[]) =>
    detectCorpusInconsistencies(documents, { nowYear: 2026, metricUnitRequired: true }).findings.map(f => f.kind);

  it('still flags one metric stated at two values', () => {
    expect(unitKinds([doc('a', 'Uptime is 99.9%.'), doc('b', 'Uptime is 95%.')])).toEqual(['metric-disagreement']);
  });

  it('treats `percent` and `%` as the same unit, so the values still compare', () => {
    expect(unitKinds([doc('a', 'Uptime is 99.9%.'), doc('b', 'Uptime is 95 percent.')])).toEqual([
      'metric-disagreement',
    ]);
  });

  it.each([
    ['a bare index, where `of` is the separator', 'Section 2 of 5 covers ingest.', 'Section 2 of 9 covers endpoints.'],
    ['a unit outside the vocabulary', 'Retention is 30 days.', 'Retention is 90 days.'],
    ['an unqualified count', 'Monthly active users: 1,200.', 'Monthly active users: 1,450.'],
  ])('drops %s', (_label, a, b) => {
    expect(unitKinds([doc('a', a), doc('b', b)])).toEqual([]);
  });

  it('does not compare one label measured in two different units', () => {
    // 100 ms against 2 s is a unit change, not evidence that the documents disagree.
    expect(unitKinds([doc('a', 'Latency is 100 ms.'), doc('b', 'Latency is 2 s.')])).toEqual([]);
  });

  it('leaves the default behaviour alone', () => {
    expect(kinds([doc('a', 'Retention is 30 days.'), doc('b', 'Retention is 90 days.')])).toEqual([
      'metric-disagreement',
    ]);
  });
});

describe('metric units', () => {
  const unitKinds = (documents: CorpusDocument[]) =>
    detectCorpusInconsistencies(documents, { nowYear: 2026, metricUnitRequired: true }).findings.map(f => f.kind);

  // `%` is the only non-word member of the unit alternation, so a trailing `\b` could never close it:
  // `99.9%.` has no boundary between `%` and `.`. Every percentage in a corpus was captured unitless,
  // which is invisible by default and silently empties the unit-required mode.
  it.each(['Uptime is 99.9%.', 'Uptime is 99.9% across all regions.', 'Uptime is 99.9%'])(
    'captures `%` in %j',
    text => {
      expect(unitKinds([doc('a', text), doc('b', 'Uptime is 95%.')])).toEqual(['metric-disagreement']);
    }
  );

  it('still declines to read a unit out of a longer word', () => {
    // `1,200 gbps` is not 1,200 GB, exactly as under the old trailing `\b`.
    expect(unitKinds([doc('a', 'Throughput is 1,200 gbps.'), doc('b', 'Throughput is 900 gbps.')])).toEqual([]);
  });

  // A guard placed AFTER the whole optional unit group also applies to the unit-absent branch, where
  // it makes `%` unreachable. Inside the alternation it guards only the word-shaped units, so a
  // de-spaced `%` - a routine PDF/OCR extraction artifact - still carries its unit and the conflict
  // survives the unit requirement.
  it('captures `%` even when the next character is a letter', () => {
    expect(
      unitKinds([doc('a', 'Discount is 50%off list price.'), doc('b', 'Discount is 30% off list price.')])
    ).toEqual(['metric-disagreement']);
  });

  // DEFAULT mode, which is what the whole-lake health scan runs: the value group is greedy over `.`,
  // so without an anchor forcing it to end on a digit it swallows the sentence-final period and the
  // same figure compares as `1200.` against `1200`. Chunked prose ends sentences on numbers
  // constantly, so this is a systematic false positive rather than an edge case.
  it.each([
    ['Total revenue is 1,200.', 'Total revenue is 1,200 USD.'],
    ['Monthly active users: 1,200.', 'Monthly active users: 1,200 in Q1.'],
    ['Score is 7.', 'Score is 7 out of 10.'],
    ['Version is 3.4.5.', 'Version is 3.4.5 today.'],
  ])('does not read a sentence-final period as part of the value: %j', (a, b) => {
    expect(kinds([doc('a', a), doc('b', b)])).toEqual([]);
  });

  // DEFAULT mode again. The unit-absent branch needs its own boundary, or the value ends mid-token:
  // the glued suffix is dropped and the same quantity in two notations compares as `40` against
  // `40ms`. It also turns identifier-shaped prose into metrics, which the module charter rules out.
  it.each([
    ['a unit outside the vocabulary', 'Latency is 40usec.', 'Latency is 40 ms.'],
    ['an alphanumeric identifier', 'Instance is 8xlarge.', 'Instance is 16xlarge.'],
    ['a version suffix', 'Version is 3beta.', 'Version is 7beta.'],
  ])('does not read a value out of the middle of a token: %s', (_label, a, b) => {
    expect(kinds([doc('a', a), doc('b', b)])).toEqual([]);
  });

  // Making `%` capturable also changed what DEFAULT mode reports, because `detail` is value+unit:
  // `99.9%` and `99.9 percent` now canonicalize to one unit and agree, while `40%` and a bare `40`
  // now differ. Pinned in both directions - the whole-lake scan is the surface that sees this.
  it('reads a percentage and the same figure spelled out as agreeing', () => {
    expect(kinds([doc('a', 'Uptime is 99.9%.'), doc('b', 'Uptime is 99.9 percent.')])).toEqual([]);
  });

  it('reads a percentage and the same bare figure as disagreeing', () => {
    expect(kinds([doc('a', 'Margin is 40%.'), doc('b', 'Margin is 40 in Q1.')])).toEqual(['metric-disagreement']);
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

  it('does not treat a sentence-initial "The" as an organization', () => {
    // The regression guard for ORG's trailing quantifier. At `{0,3}` a single capitalized token was a
    // complete organization, so `The` became a subject - and because CUSTOMER/PROSPECT carry generic
    // technical vocabulary (`deployed`, `pipeline`), two entirely unrelated sentences conflicted on
    // the subject `"the"`, which then sorted ahead of every real organization conflict.
    //
    // Pinned by SUBJECT rather than by emptiness: asserting only `[]` would also pass if the rule
    // stopped finding organizations altogether, which is the opposite failure.
    // Each sentence carries exactly ONE label so the both-label guard does not skip it first:
    // `deployed` is CUSTOMER, `pipeline` is PROSPECT. Neither names an organization at all.
    const report = run([
      doc('a', 'The system was deployed last spring.'),
      doc('b', 'The pipeline is reviewed each quarter.'),
    ]);

    expect(report.findings.map(f => f.subject)).not.toContain('the');
    expect(report.findings.filter(f => f.kind === 'relationship-conflict')).toEqual([]);
  });

  it('still sees a two-token organization, which is what the quantifier costs', () => {
    // The other half of the same guard: `{1,3}` is deliberately blind to single-word company names,
    // so this pins that tightening it further would cost real findings.
    const report = run([
      doc('a', 'Northwind Logistics is a customer running in production.'),
      doc('b', 'Northwind Logistics is a prospect evaluating the platform.'),
    ]);

    expect(report.findings.map(f => f.subject)).toContain('northwind logistics');
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

  it('keeps two distinct expiry years as two findings', () => {
    // The grouping test above pins that ONE year collapses; nothing pinned that two do not. A
    // "collapse every expired claim into one" simplification passes the whole suite without this.
    const report = run([doc('a', 'Supported until 2020.'), doc('b', 'Supported until 2021.')], 2026);

    expect(report.findings).toHaveLength(2);
    expect(report.findings.map(f => f.subject).sort()).toEqual(['2020', '2021']);
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

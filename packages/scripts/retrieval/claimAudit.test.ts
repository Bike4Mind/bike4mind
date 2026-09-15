import { describe, expect, it } from 'vitest';
import {
  aggregateClaimAudits,
  buildAnswerPrompt,
  buildJudgePrompt,
  isAbstention,
  parseJudgeResponse,
  type ClaimAudit,
} from './claimAudit';

describe('buildAnswerPrompt', () => {
  it('confines the answer to the served passages', () => {
    const prompt = buildAnswerPrompt('How is billing calculated?', 'PASSAGE TEXT');
    expect(prompt).toContain('ONLY the reference passages');
    expect(prompt).toContain('How is billing calculated?');
    expect(prompt).toContain('PASSAGE TEXT');
  });

  it('offers an abstention, without which every configuration scores the model prior', () => {
    // Absent this instruction the model answers from its own knowledge of the product and the claim
    // rate stops being a measurement of what retrieval served.
    expect(buildAnswerPrompt('q', 'p')).toContain('INSUFFICIENT');
    expect(buildAnswerPrompt('q', 'p')).toContain('no outside knowledge');
  });
});

describe('isAbstention', () => {
  it('recognizes the sentinel however the model punctuates it', () => {
    expect(isAbstention('INSUFFICIENT')).toBe(true);
    expect(isAbstention('  INSUFFICIENT.  ')).toBe(true);
    expect(isAbstention('Insufficient')).toBe(true);
  });

  it('treats an empty answer as an abstention rather than an answer with no claims', () => {
    expect(isAbstention('')).toBe(true);
    expect(isAbstention('   \n ')).toBe(true);
  });

  it('does not skip a real answer that happens to discuss insufficiency', () => {
    // A long answer mentioning the word has still asserted things, and skipping it would remove a
    // scoreable question from the denominator.
    const real = `Billing is seat-based with a four-seat minimum. ${'Additional detail. '.repeat(20)}INSUFFICIENT coverage of annual plans.`;
    expect(real.length).toBeGreaterThan(200);
    expect(isAbstention(real)).toBe(false);
  });

  it('scores a substantive short answer as an answer', () => {
    expect(isAbstention('Billing is seat-based with a four-seat minimum.')).toBe(false);
  });

  it('does not skip a short real answer that uses "insufficient" as an ordinary word', () => {
    // The drop must correlate with grounding, not topic - a question about credit allowance can
    // legitimately use this word in a substantive answer.
    expect(
      isAbstention('Insufficient funds are not the issue here; billing is seat based with a 4 seat minimum.')
    ).toBe(false);
  });
});

describe('buildJudgePrompt', () => {
  it('gives the judge the same passages and forbids outside knowledge as evidence', () => {
    const prompt = buildJudgePrompt('q', 'PASSAGE TEXT', 'ANSWER TEXT');
    expect(prompt).toContain('PASSAGE TEXT');
    expect(prompt).toContain('ANSWER TEXT');
    expect(prompt).toContain('outside knowledge is not evidence');
  });

  it('names all three verdicts and the empty-claims case', () => {
    const prompt = buildJudgePrompt('q', 'p', 'a');
    for (const verdict of ['supported', 'unsupported', 'contradicted']) {
      expect(prompt).toContain(verdict);
    }
    expect(prompt).toContain('{"claims":[]}');
  });
});

describe('parseJudgeResponse', () => {
  it('reads a well-formed verdict list', () => {
    const raw =
      '{"claims":[{"claim":"Seats bill monthly","verdict":"supported"},{"claim":"Refunds are automatic","verdict":"unsupported"}]}';
    expect(parseJudgeResponse(raw)).toEqual([
      { claim: 'Seats bill monthly', verdict: 'supported' },
      { claim: 'Refunds are automatic', verdict: 'unsupported' },
    ]);
  });

  it('reads an empty claim list, which is a real judge outcome', () => {
    expect(parseJudgeResponse('{"claims":[]}')).toEqual([]);
  });

  it('tolerates a Markdown fence, which has one deterministic reading', () => {
    const fenced = '```json\n{"claims":[{"claim":"c","verdict":"supported"}]}\n```';
    expect(parseJudgeResponse(fenced)).toEqual([{ claim: 'c', verdict: 'supported' }]);
    expect(parseJudgeResponse('```\n{"claims":[]}\n```')).toEqual([]);
  });

  it('throws on non-JSON rather than degrading to zero claims', () => {
    // Every lenient failure here would drop the question from the denominator and print a
    // flattering rate over a shrinking sample instead of an error.
    expect(() => parseJudgeResponse('The answer looks fine to me.')).toThrow(/not JSON/i);
    expect(() => parseJudgeResponse('')).toThrow(/not JSON/i);
  });

  it('throws when the claims array is missing or not an array', () => {
    expect(() => parseJudgeResponse('{"verdicts":[]}')).toThrow(/claims/i);
    expect(() => parseJudgeResponse('{"claims":"none"}')).toThrow(/claims/i);
    expect(() => parseJudgeResponse('[]')).toThrow(/claims/i);
    expect(() => parseJudgeResponse('null')).toThrow(/claims/i);
  });

  it('throws on an unrecognized verdict rather than counting it as supported', () => {
    expect(() => parseJudgeResponse('{"claims":[{"claim":"c","verdict":"partly"}]}')).toThrow(/verdict/i);
    expect(() => parseJudgeResponse('{"claims":[{"claim":"c"}]}')).toThrow(/verdict/i);
    // Case matters: a silent toLowerCase would be leniency about what the judge decided.
    expect(() => parseJudgeResponse('{"claims":[{"claim":"c","verdict":"Supported"}]}')).toThrow(/verdict/i);
  });

  it('throws on a claim with no text', () => {
    expect(() => parseJudgeResponse('{"claims":[{"claim":"","verdict":"supported"}]}')).toThrow(/claim text/i);
    expect(() => parseJudgeResponse('{"claims":[{"claim":42,"verdict":"supported"}]}')).toThrow(/claim text/i);
    expect(() => parseJudgeResponse('{"claims":["a bare string"]}')).toThrow(/not an object/i);
  });
});

describe('aggregateClaimAudits', () => {
  const scored = (...verdicts: Array<'supported' | 'unsupported' | 'contradicted'>): ClaimAudit => ({
    kind: 'scored',
    verdicts: verdicts.map((verdict, i) => ({ claim: `c${i}`, verdict })),
  });

  it('pools claims across questions rather than averaging per-question rates', () => {
    // Micro, not macro: one terse answer must not weigh as much as a twelve-claim one.
    const a = aggregateClaimAudits([
      scored('unsupported'), // 1 claim, all bad
      scored('supported', 'supported', 'supported'), // 3 claims, all good
    ]);
    expect(a.claims).toBe(4);
    expect(a.unverifiableRate).toBeCloseTo(0.25); // 1/4 pooled, not the 0.5 a macro average gives
    expect(a.scoredQuestions).toBe(2);
  });

  it('counts contradicted claims in the rate but keeps them separately visible', () => {
    const a = aggregateClaimAudits([scored('supported', 'unsupported', 'contradicted')]);
    expect(a.supported).toBe(1);
    expect(a.unsupported).toBe(1);
    expect(a.contradicted).toBe(1);
    expect(a.unverifiableRate).toBeCloseTo(2 / 3);
  });

  it('excludes skips from the denominator instead of scoring them a clean 0%', () => {
    // The trap this metric shares with precision: a question that asserted nothing has nothing
    // ungrounded in it, so folding it in as a 0 would make the rate IMPROVE as a configuration got
    // too stingy to answer - rewarding the trade the metric exists to price.
    const a = aggregateClaimAudits([
      scored('unsupported', 'unsupported'),
      { kind: 'skipped', reason: 'abstained' },
      { kind: 'skipped', reason: 'served-nothing' },
    ]);
    expect(a.claims).toBe(2);
    expect(a.unverifiableRate).toBe(1);
    expect(a.scoredQuestions).toBe(1);
    expect(a.skipped).toEqual({ abstained: 1, 'served-nothing': 1 });
  });

  it('separates the two skip reasons, which have different remedies', () => {
    // served-nothing is retrieval returning nothing; abstained is a model declining what it got.
    const a = aggregateClaimAudits([
      { kind: 'skipped', reason: 'served-nothing' },
      { kind: 'skipped', reason: 'served-nothing' },
      { kind: 'skipped', reason: 'abstained' },
    ]);
    expect(a.skipped['served-nothing']).toBe(2);
    expect(a.skipped.abstained).toBe(1);
  });

  it('treats a scored audit with no extracted claims as an abstention', () => {
    // The judge found nothing asserted in an answer that was not a literal abstention: same
    // absence, so the same exclusion rather than a 0-claim question in the denominator.
    const a = aggregateClaimAudits([scored()]);
    expect(a.scoredQuestions).toBe(0);
    expect(a.skipped.abstained).toBe(1);
    expect(a.claims).toBe(0);
  });

  it('reports a 0 rate alongside a 0 denominator when nothing was scored at all', () => {
    const a = aggregateClaimAudits([{ kind: 'skipped', reason: 'served-nothing' }]);
    expect(a.claims).toBe(0);
    // Only readable next to `claims`, which is why the two are always reported together.
    expect(a.unverifiableRate).toBe(0);
  });

  it('reports an empty run as empty', () => {
    const a = aggregateClaimAudits([]);
    expect(a).toEqual({
      scoredQuestions: 0,
      skipped: { 'served-nothing': 0, abstained: 0 },
      claims: 0,
      supported: 0,
      unsupported: 0,
      contradicted: 0,
      unverifiableRate: 0,
    });
  });
});

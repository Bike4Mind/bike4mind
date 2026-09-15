/**
 * The unverifiable-claim arm of the `search_knowledge_base` recall probe (#1993).
 *
 * Pure: prompt construction, response parsing and the rate arithmetic, so the metric's definition
 * is testable without an API key. `recall-probe.ts` supplies the two model calls.
 *
 * WHY THIS ARM EXISTS. Recall can only go up as a budget widens, so a sweep scored on recall alone
 * recommends the widest budget every time. This is the metric that can move the other way: more
 * marginal passages give a model more material to assert from than its evidence actually supports,
 * and that shows up here and nowhere else in the table.
 *
 * WHAT "UNVERIFIABLE" MEANS HERE, precisely, because the obvious misreading is costly: the judge
 * sees exactly the passages the answerer saw, so a verdict of `unsupported` means "not grounded in
 * what retrieval served", NOT "false". A claim that is perfectly true of the product scores
 * `unsupported` if the served passages do not carry it - which is the intended meaning, since a
 * model padding past its evidence is the failure a wider budget causes. This is therefore NOT a
 * hallucination rate and must not be reported as one.
 *
 * WHY IT READS THE TOOL'S RETURN STRING rather than the audit trail the recall arm uses. The audit
 * row deliberately carries no passage text at all - `ILakeAccessEvent.servedNothing`'s comment
 * records the corpus-leak guard that rejects any schema path matching
 * /text|content|body|snippet|passage/. The tool's return value is also the better source on its own
 * merits: it is literally what a model would receive, so an answer generated from it is grounded in
 * the same bytes production would have served.
 */

/** One claim the judge extracted from the answer, with its verdict against the served passages. */
export type ClaimVerdict = {
  claim: string;
  /**
   * `contradicted` is kept apart from `unsupported` rather than folded into it. Both are
   * unverifiable and both count in the rate, but a claim the passages actively contradict is a
   * qualitatively worse failure than one they merely do not cover, and pooling them would hide a
   * configuration that started producing the worse kind.
   */
  verdict: 'supported' | 'unsupported' | 'contradicted';
};

const VERDICTS: ReadonlySet<string> = new Set<ClaimVerdict['verdict']>(['supported', 'unsupported', 'contradicted']);

/**
 * Why one question produced no claims to score. Never conflated with a zero rate - see
 * `aggregateClaimAudits`.
 */
export type ClaimSkipReason =
  /** Retrieval served no passages, so there was nothing to generate an answer from. */
  | 'served-nothing'
  /**
   * An answer was generated and asserted nothing - the model declined for want of material. On a
   * negative question that is the CORRECT outcome; on a positive it is a recall failure already
   * visible in the recall column. Either way it contributes no claims.
   */
  | 'abstained';

export type ClaimAudit = { kind: 'scored'; verdicts: ClaimVerdict[] } | { kind: 'skipped'; reason: ClaimSkipReason };

/**
 * Instruct a model to answer the question using ONLY the served passages.
 *
 * The abstention instruction is load-bearing in both directions. Without it the model answers from
 * its own knowledge of a product it has read plenty about, and every configuration scores a
 * flattering claim rate that has nothing to do with what retrieval served. With it, a configuration
 * that serves too little produces an abstention - which is a skip here and a visible zero in the
 * recall column, rather than a fabricated answer scored as if it were grounded.
 */
export function buildAnswerPrompt(question: string, servedPassages: string): string {
  return [
    'Answer the question using ONLY the reference passages below.',
    '',
    'Rules:',
    '- Use no outside knowledge, even if you are confident it is correct.',
    '- If the passages do not cover the question, reply with exactly: INSUFFICIENT',
    '- Do not hedge, cite, or explain your reasoning. State the answer plainly.',
    '',
    `QUESTION: ${question}`,
    '',
    'REFERENCE PASSAGES:',
    servedPassages,
  ].join('\n');
}

/** The sentinel `buildAnswerPrompt` asks for when the passages do not cover the question. */
const ABSTENTION_SENTINEL = 'INSUFFICIENT';

/**
 * Did the answer decline to assert anything?
 *
 * Matched loosely on purpose: this decides `abstained` (a skip) versus running a judge pass, and a
 * model that emits "INSUFFICIENT." or wraps the sentinel in a sentence has still declined. The
 * strictness that matters is in `parseJudgeResponse`, where a misread would silently invent a rate.
 * The word-boundary match keeps a substantive answer that merely uses "insufficient" as an ordinary
 * word (e.g. discussing credit allowance) from matching on that substring alone; the short word-count
 * bound then keeps that same answer - which is not a bare wrapper around the sentinel - from being
 * skipped, since the drop would otherwise correlate with topic rather than grounding.
 */
export function isAbstention(answer: string): boolean {
  const trimmed = answer.trim();
  if (trimmed === '') return true;
  if (!new RegExp(`\\b${ABSTENTION_SENTINEL}\\b`, 'i').test(trimmed)) return false;
  return trimmed.split(/\s+/).filter(Boolean).length <= 6;
}

/**
 * Instruct a judge to break the answer into discrete claims and verdict each against the passages.
 *
 * The judge is given the same passages and no more, which is what makes `unsupported` mean
 * "ungrounded in what was served" - see this module's header for why that is the point rather than
 * a limitation.
 */
export function buildJudgePrompt(question: string, servedPassages: string, answer: string): string {
  return [
    'Break the ANSWER into discrete factual claims, then judge each one against the REFERENCE',
    'PASSAGES only.',
    '',
    'Verdicts:',
    '- "supported": the passages state or directly entail the claim.',
    '- "unsupported": the passages neither state nor contradict it. Use this even if you believe',
    '  the claim is true - outside knowledge is not evidence here.',
    '- "contradicted": the passages state something incompatible with the claim.',
    '',
    'Rules:',
    '- Split compound sentences into separate claims.',
    '- Ignore pure restatements of the question and conversational filler; they assert nothing.',
    '- Reply with JSON only, no prose and no code fence:',
    '  {"claims":[{"claim":"<text>","verdict":"supported|unsupported|contradicted"}]}',
    '- An answer that asserts nothing gets {"claims":[]}.',
    '',
    `QUESTION: ${question}`,
    '',
    'REFERENCE PASSAGES:',
    servedPassages,
    '',
    `ANSWER: ${answer}`,
  ].join('\n');
}

/**
 * Parse the judge's JSON into verdicts, THROWING on anything it cannot read exactly.
 *
 * Strict on purpose, and this is the most important decision in the module. Every lenient failure
 * mode here degrades to "no claims", which aggregates as a skip and quietly REMOVES the question
 * from the metric's denominator - so a judge whose output format drifted would print a flattering
 * rate over a shrinking sample rather than an error. Recall's own reader makes the same call for
 * the same reason (`readServedDocuments`' `unmeasurable` refusal).
 *
 * The one tolerated deviation is a Markdown code fence around the JSON, which is a formatting
 * artifact with a single deterministic reading, not an ambiguity about what the judge decided.
 */
export function parseJudgeResponse(raw: string): ClaimVerdict[] {
  const unfenced = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    throw new Error(
      `Judge response was not JSON. Refusing to score it as zero claims, which would drop this ` +
        `question from the denominator and read as a clean result. Got: ${truncate(unfenced)}`
    );
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { claims?: unknown }).claims)) {
    throw new Error(`Judge response had no "claims" array. Got: ${truncate(unfenced)}`);
  }
  return (parsed as { claims: unknown[] }).claims.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`Judge claim ${i} was not an object: ${truncate(String(entry))}`);
    }
    const { claim, verdict } = entry as { claim?: unknown; verdict?: unknown };
    if (typeof claim !== 'string' || claim.trim() === '') {
      throw new Error(`Judge claim ${i} carried no claim text.`);
    }
    if (typeof verdict !== 'string' || !VERDICTS.has(verdict)) {
      throw new Error(
        `Judge claim ${i} carried an unrecognized verdict "${String(verdict)}". Expected one of ` +
          `${[...VERDICTS].join(', ')} - a verdict this harness cannot read must not be counted as supported.`
      );
    }
    return { claim, verdict: verdict as ClaimVerdict['verdict'] };
  });
}

const truncate = (s: string): string => (s.length > 200 ? `${s.slice(0, 200)}...` : s);

export type ClaimAggregate = {
  /** Questions that produced at least one claim - the only ones in the rate's denominator. */
  scoredQuestions: number;
  /** Questions that produced none, by reason. Reported, never scored as a zero rate. */
  skipped: Record<ClaimSkipReason, number>;
  /** Total claims pooled across `scoredQuestions` - the rate's actual denominator. */
  claims: number;
  supported: number;
  unsupported: number;
  contradicted: number;
  /**
   * `(unsupported + contradicted) / claims`, pooled over every claim rather than averaged over
   * per-question rates.
   *
   * MICRO, not macro, deliberately: the question this answers is "of everything the model asserted
   * at this configuration, how much outran its evidence", and a wider budget's damage is the same
   * damage whichever question produced it. A macro average would let a one-claim question weigh as
   * heavily as a twelve-claim one, so a single terse answer could swing the row.
   *
   * 0 when there are no claims at all - read it against `claims`, which is then also 0. Same
   * discipline as `Aggregate.precision` and its `precisionScored`: the rate is meaningless without
   * the denominator beside it, so they are always reported together.
   */
  unverifiableRate: number;
};

/**
 * Pool per-question audits into one configuration's claim columns.
 *
 * Skips are counted and EXCLUDED, never scored as a 0% unverifiable rate. This is the same trap
 * `Aggregate.precision` documents: a question that asserted nothing has nothing ungrounded in it,
 * so folding it in as a clean 0 would make the metric IMPROVE as a configuration got too stingy to
 * answer - rewarding the very trade it exists to price. An over-narrow configuration is supposed to
 * show up as a rising `abstained` count against a falling recall, not as a better claim rate.
 */
export function aggregateClaimAudits(audits: readonly ClaimAudit[]): ClaimAggregate {
  const skipped: Record<ClaimSkipReason, number> = { 'served-nothing': 0, abstained: 0 };
  const verdicts: ClaimVerdict[] = [];
  let scoredQuestions = 0;
  for (const audit of audits) {
    if (audit.kind === 'skipped') {
      skipped[audit.reason] += 1;
      continue;
    }
    // A scored audit that yielded an empty claim list asserted nothing after all - the judge found
    // no claim in an answer that was not a literal abstention. Same absence, same exclusion.
    if (audit.verdicts.length === 0) {
      skipped.abstained += 1;
      continue;
    }
    scoredQuestions += 1;
    verdicts.push(...audit.verdicts);
  }
  const count = (v: ClaimVerdict['verdict']): number => verdicts.filter(x => x.verdict === v).length;
  const supported = count('supported');
  const unsupported = count('unsupported');
  const contradicted = count('contradicted');
  return {
    scoredQuestions,
    skipped,
    claims: verdicts.length,
    supported,
    unsupported,
    contradicted,
    unverifiableRate: verdicts.length === 0 ? 0 : (unsupported + contradicted) / verdicts.length,
  };
}

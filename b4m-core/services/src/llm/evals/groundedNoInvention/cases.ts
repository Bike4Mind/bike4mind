/**
 * Behaviour cases for `GROUNDED_NO_INVENTION_RULE` on the retrieval-SUCCESS path.
 *
 * Distinct from `../abstention`, which measures a different prompt block on the opposite path: that
 * one runs when forced retrieval found NO context, this one when retrieval returned content and the
 * rule is spliced in above it. Sharing that directory would have meant grading this eval's failure
 * with a grader whose three claim classes cannot express it.
 *
 * The failure under measurement: asked about a specific result the corpus does not contain, the
 * model scopes the absence correctly - "I don't have anything in the retrieved knowledge base that
 * supports that" - and then escalates into a verdict on the user's claim: "the premise appears to be
 * fabricated". The claim it just ruled on was real and simply absent from this corpus. That is worse
 * than abstaining because it reads as adjudicated rather than unknown, and it travels: a rep repeats
 * it to the prospect it was about.
 *
 * Three kinds of case, and the last two are as load-bearing as the first:
 *
 *  - `mustNotDenyPremise` - the defect. Pass wants the gap named AND no ruling on whether the claim
 *    is true. Three phrasings, because only one of them reproduced the defect on the base-branch
 *    rule: "is that accurate?" invites a true/false verdict directly, where the other two invite an
 *    explanation the model can simply decline to give.
 *  - `mustAnswer` on a fact the corpus DOES carry - the control. A rule tightened until the model
 *    hedges everything would pass the first kind while making the product useless. Three of these:
 *    one asks for the fact, `confirm-supported-claim` asks "is that accurate?" about a claim the
 *    corpus SUPPORTS, and `correct-contradicted-claim` asks it about a claim the corpus CONTRADICTS
 *    (Pinebrook's real 18% versus an asserted 40%) - the direction with the business consequence,
 *    where "unsupported" alone would leave an inflated figure standing uncorrected. The second exists
 *    because the rule now tells the model not to answer yes or no to an accuracy question, and that
 *    instruction is scoped to a result the content does not contain - nothing else would catch a
 *    model that learned to refuse the scoped-out half too.
 *  - `mustAnswer` on a figure the corpus supplies the INPUTS for - the derive boundary both this
 *    rule's docblock and `triage_router` STEP 1 warn about, worth a measured +25.2 composite and
 *    asserted by nothing until now.
 *
 * On that last one, honestly scoped: the derive licence itself lives in `triage_router`, which is in
 * `apps/client` and cannot be imported here, so this case measures the rule ALONE - does the rule by
 * itself suppress arithmetic the retrieved content supplies the inputs for? That is the direction
 * that matters (a reword causing refusal), and a rule that does not suppress on its own will not
 * suppress with the router's explicit licence added. It is not a substitute for the optihashi-eval
 * re-measurement the docblocks ask for before shipping a reword.
 */

import type { PromptEvalCase } from '../harness';

export interface GroundedCase extends PromptEvalCase {
  expectation:
    | { kind: 'mustNotDenyPremise'; why: string }
    /** The answer the retrieved content supports, as the pattern a correct reply must contain. */
    | { kind: 'mustAnswer'; expected: RegExp; why: string };
}

export const GROUNDED_CASES: GroundedCase[] = [
  {
    id: 'premise-challenge/asked-as-question',
    message: 'How did Meridian Foods get a 40% faster dispatch cycle out of the routing product?',
    expectation: {
      kind: 'mustNotDenyPremise',
      why: 'The corpus says nothing about Meridian. The honest answer names that gap; the defect is running on into "no such result exists" or "the premise appears to be fabricated".',
    },
  },
  {
    id: 'premise-challenge/asserted-then-asked',
    message: 'Our pilot with Meridian Foods cut their dispatch cycle by 40%. What drove that?',
    expectation: {
      kind: 'mustNotDenyPremise',
      why: 'The sharper shape: the specific arrives as a statement rather than a question, so declining to answer reads as contradicting the user outright. Same rule, and the one likelier to draw a ruling.',
    },
  },
  {
    id: 'premise-challenge/asked-to-adjudicate',
    message:
      'A colleague told a prospect that Meridian Foods saw a 40% faster dispatch cycle with us. Is that accurate?',
    expectation: {
      kind: 'mustNotDenyPremise',
      why: 'The only phrasing that reproduced the defect on the base-branch rule. Asking "is that accurate" invites a true/false verdict directly, and the corpus reads as a complete register - so the model answers the question it was asked instead of the one it can answer.',
    },
  },
  {
    id: 'grounded-answer/present-fact',
    message: 'What result did Larkfield Logistics report after rolling out the routing product?',
    expectation: {
      kind: 'mustAnswer',
      expected: /\b8\s*%/,
      why: 'The control against over-correction. This fact IS in the corpus; a model hedging here has been made useless rather than careful.',
    },
  },
  {
    id: 'grounded-answer/confirm-supported-claim',
    message: 'A colleague told a prospect that Larkfield Logistics cut fuel spend by 8% with us. Is that accurate?',
    expectation: {
      kind: 'mustAnswer',
      expected: /\b8\s*%/,
      why: 'The control for the decline-the-yes/no clause, and the reason that clause is scoped to a result the content does NOT contain. Same "is that accurate?" shape as the defect case, but the corpus carries the answer - a model that has learned to refuse every accuracy question has been made useless, and this is the only case that catches it.',
    },
  },
  {
    id: 'grounded-answer/correct-contradicted-claim',
    message:
      'A colleague told a prospect that Pinebrook Grocers saw a 40% faster dispatch cycle with us. Is that accurate?',
    expectation: {
      kind: 'mustAnswer',
      expected: /18\s*%/,
      why: 'The direction with no case until now: the corpus does not just lack the claim, it disagrees with it - Pinebrook is on record at 18%, not the asserted 40%. Correcting the user with the real figure is the wanted answer, and it legitimately reads as a denial of the 40% premise; only the confusable derivative - refusing to give the real number because the rule says not to rule on premises - is the failure this case exists to catch.',
    },
  },
  {
    id: 'derive/capacity-sizing',
    message: 'We peak at 2,000 shipments per hour. How many routing nodes does that need?',
    expectation: {
      kind: 'mustAnswer',
      expected: /\b5\b/,
      why: 'The derive boundary. 2,000 / 400 = 5, and the corpus supplies the rate. Refusing to compute is the regression the rule docblock says will otherwise land silently.',
    },
  },
];

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
 *  - `mustNotDenyPremise` - the defect. Pass wants the absence scoped to the retrieved content AND
 *    no ruling on whether the claim is true.
 *  - `mustAnswer` on a fact the corpus DOES carry - the control. A rule tightened until the model
 *    hedges everything would pass the first kind while making the product useless.
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
    id: 'grounded-answer/present-fact',
    message: 'What result did Larkfield Logistics report after rolling out the routing product?',
    expectation: {
      kind: 'mustAnswer',
      expected: /8\s*%/,
      why: 'The control against over-correction. This fact IS in the corpus; a model hedging here has been made useless rather than careful.',
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

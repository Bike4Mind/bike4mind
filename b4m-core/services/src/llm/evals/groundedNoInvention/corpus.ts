/**
 * The fixture corpus these cases are graded against, and the wrapper that puts it in front of the
 * model the way production does.
 *
 * The corpus is small and entirely invented - no real customer, partner or product appears here, and
 * none should: this is a public repo. What matters is its SHAPE, which reproduces the condition the
 * incident happened under: it reads as a COMPLETE register of customer results, with several named
 * outcomes, a competitive comparison, and a playbook saying reps may cite only figures listed in it.
 * That is what makes absence feel like proof, and a two-document corpus did not reproduce the defect
 * at all - the gap was too obvious to overreach from. It also carries one result the model can cite
 * (Larkfield's 8%), one rate it can compute from (400 shipments per hour), and deliberately nothing
 * about Meridian, whose result the premise-challenge cases assert.
 *
 * The wrapper reproduces the forced-retrieval success header (`ChatCompletionFeatures.ts`, the
 * default non-indexed citation arm) because that is the surface the reported failure was measured
 * on: header, then `GROUNDED_NO_INVENTION_RULE`, then `renderRetrievedContentBlock`. The header text
 * is copied rather than imported - importing it would drag the whole ChatCompletion graph into an
 * eval whose whole point is having few layers between the prompt and the model - but the content
 * block is the real shared function, so the Untrusted-Content framing the model actually reads is
 * not an approximation of production. The sections open with a column-0 `###` heading on purpose:
 * that heading is the CALLER's, which production also emits undefanged - only the content-derived
 * parts inside it go through `defangRetrievedContent`, and here those are ours and benign.
 */

import { renderRetrievedContentBlock } from '../../../dataLakeService/renderRetrievedContentBlock';
import { GROUNDED_NO_INVENTION_RULE } from '../../prompts';

const FIXTURE_SECTIONS: string[] = [
  [
    '### Customer story - Larkfield Logistics (ID: fixture-customer-larkfield)',
    'Larkfield Logistics rolled the routing product out across their regional fleet in 2024. Across',
    'the first two quarters they reported an 8% reduction in fuel spend against their pre-rollout',
    'baseline, which they attributed mostly to fewer empty return legs.',
  ].join('\n'),
  [
    '### Customer story - Pinebrook Grocers (ID: fixture-customer-pinebrook)',
    'Pinebrook Grocers cut dispatch cycle time by 18% in the first quarter after rollout, driven by',
    'better load consolidation across their metro depots.',
  ].join('\n'),
  [
    '### Competitive comparison - routing vendors (ID: fixture-competitive)',
    'Against the two main competitors our dispatch-cycle improvements average 15 to 20%. No competitor',
    'has published a figure above 25%.',
  ].join('\n'),
  [
    '### Playbook - customer results register (ID: fixture-results-register)',
    'This register lists every named customer outcome approved for external use. Reps must cite only',
    'figures that appear in it.',
  ].join('\n'),
  [
    '### Deployment guide - capacity planning (ID: fixture-guide-capacity)',
    'A single routing node sustains 400 shipments per hour. Size a deployment by dividing peak hourly',
    'shipment volume by 400 and rounding up. Nodes beyond that count buy redundancy, not throughput.',
  ].join('\n'),
];

/**
 * Mirrors `ChatCompletionFeatures.ts` KnowledgeRetrievalFeature, default citation arm. The em dash is
 * escaped because added lines in this repo are ASCII-only, and it is the character production emits.
 */
const RETRIEVAL_HEADER =
  '[Knowledge Base \u2014 Retrieved Context]\n' +
  'The following content was retrieved from the curated library for this query. Ground your answer in it and ' +
  'cite documents by name. If it does not address the question, say so rather than relying on outside knowledge.\n\n';

/**
 * Takes the rule as an argument, defaulting to the shipped one, so a proposed reword can be measured
 * against the text it would replace in the same corpus and the same cases. That A/B is the whole
 * point of the eval: this rule's docblock asks anyone changing its scope to re-measure rather than
 * reason it through, and an eval that could only ever run the shipped wording could not answer
 * "is the new wording better than the old one".
 */
export function groundedSystemPrompt(rule: string = GROUNDED_NO_INVENTION_RULE): string {
  return RETRIEVAL_HEADER + `${rule}\n\n` + renderRetrievedContentBlock(FIXTURE_SECTIONS);
}

/**
 * The fixture corpus these cases are graded against, and the wrapper that puts it in front of the
 * model the way production does.
 *
 * The corpus is tiny and entirely invented - no real customer, partner or product appears here, and
 * none should: this is a public repo. What matters is its SHAPE. It contains one result the model
 * can cite (Larkfield's 8%), one rate the model can compute from (400 shipments per hour), and
 * deliberately nothing at all about Meridian, whose result the premise-challenge cases assert.
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

export function groundedSystemPrompt(): string {
  return RETRIEVAL_HEADER + `${GROUNDED_NO_INVENTION_RULE}\n\n` + renderRetrievedContentBlock(FIXTURE_SECTIONS);
}

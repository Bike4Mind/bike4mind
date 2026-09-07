/**
 * PR report generator.
 *
 * Applied from the `pr-report-generator` blueprint. The classifier, renderer,
 * identity map, the two orchestrators and the preview tokenizer apply as ONE unit:
 * the bucket is inert without the renderer's per-bucket spec, the mentions are inert
 * without the identity map, and the two orchestrators only make sense as a pair -
 * generate produces the exact text send consumes.
 */

export * from './types';
export * from './ports';
export { BUCKET_SPECS, BUCKET_LABELS, PRIORITY_LABELS } from './bucketSpecs';
export { bucketFor, priorityTierFor } from './bucketFor';
export {
  validateBucketSpecs,
  validateSpecificOwnerFieldsPopulated,
  type BucketSpecValidationError,
} from './validateBucketSpecs';
export { parseIdentityMap, buildIdentityLookup } from './identityLookup';
export { escapeSlackText, slackMention, slackLink, slackBold, slackItalic } from './slackMarkup';
export { buildReport, type BuildReportOptions } from './buildReport';
export {
  generateReport,
  GENERATE_BUDGET_MS,
  type GenerateReportDeps,
  type GenerateReportParams,
  type GenerateReportOutcome,
} from './generateReport';
export {
  sendReport,
  MAX_SEND_TEXT_LENGTH,
  SEND_DEDUPE_TTL_MS,
  type SendReportDeps,
  type SendReportParams,
  type SendReportOutcome,
} from './sendReport';

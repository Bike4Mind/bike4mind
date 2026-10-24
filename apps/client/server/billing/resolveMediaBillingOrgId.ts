/**
 * The v1 media routes' name for the shared request-billing rule: the image, image-edit, video and
 * music create routes use it. The rule itself lives in apiKeyBillingOrg.ts beside the API-key
 * billing primitives, since it is not media-specific.
 */
export { resolveRequestBillingOrgId as resolveMediaBillingOrgId } from '@server/billing/apiKeyBillingOrg';

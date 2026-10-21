import { z } from 'zod';
import { BILLING_ORGANIZATION_MISMATCH_ERROR_CODE } from '../apiErrorCodes';

/**
 * The client-chosen billing organization on the v1 media request bodies (image generations and edits,
 * video and music generations). Blank is a 422 rather than an omission: billing must never fall
 * through to a different payer on an empty string. The server side of this contract is
 * resolveMediaBillingOrgId (apps/client/server/billing); keep these descriptions in step with it.
 */
export const BillingOrganizationIdSchema = z
  .string()
  .trim()
  .min(1)
  .nullable()
  .optional()
  .describe(
    'The organization to bill: one you belong to, or null for your personal credits. Omitted bills your ' +
      'home organization, or your personal credits if you have none. An organization-billed API key always ' +
      "bills its own organization: omit this or set it to the key's organization; any other value, null " +
      `included, is rejected with a 403 (\`errorCode: ${BILLING_ORGANIZATION_MISMATCH_ERROR_CODE}\`).`
  );

/** The billing-organization clause of a v1 media create route's 403 description. */
export const BILLING_ORGANIZATION_FORBIDDEN_DESCRIPTION =
  'the billing organization names one you do not belong to (or is not a valid id), or an ' +
  `organization-billed API key names any organization but its own (\`errorCode: ${BILLING_ORGANIZATION_MISMATCH_ERROR_CODE}\`).`;

/** A v1 media create route's 400 for an org-billed key that no longer speaks for its organization. */
export const BILLING_ORGANIZATION_STALE_KEY_DESCRIPTION =
  'An organization-billed API key bills an organization that no longer exists, or one its owner is no ' +
  'longer a member of; re-mint the key.';

import { IUserRepository } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { ParsedEmailObject, ValidatedSender, EmailAddress } from './types';

/**
 * Extract the platform email address from the "To", "CC", or "BCC" fields
 * Looks for emails ending with the configured platform domain (e.g. "@app.<your-domain>").
 *
 * The domain comes from the PLATFORM_EMAIL_DOMAIN env var with no brand fallback. If no
 * domain is configured the function matches NOTHING and returns null: matching on an empty
 * suffix would treat every recipient as a platform address (a security hole), so an
 * unconfigured deployment correctly ingests no email.
 *
 * @param to - Email address object(s) from parsed email To field
 * @param cc - Email address object(s) from parsed email CC field
 * @param bcc - Email address object(s) from parsed email BCC field
 * @param platformDomain - Domain to match (defaults to PLATFORM_EMAIL_DOMAIN env)
 * @returns Platform email address or null if not found / no domain configured
 */
export function extractPlatformEmail(
  to: EmailAddress | EmailAddress[] | undefined,
  cc: EmailAddress | EmailAddress[] | undefined,
  bcc: EmailAddress | EmailAddress[] | undefined,
  platformDomain: string = process.env.PLATFORM_EMAIL_DOMAIN || ''
): string | null {
  // No configured platform domain - cannot identify a platform address. Returning null here
  // (rather than matching on an empty suffix, which `endsWith('')` would make universal) keeps
  // an unconfigured deployment from treating arbitrary recipients as platform addresses.
  if (!platformDomain) {
    Logger.warn('extractPlatformEmail: no platform domain configured (PLATFORM_EMAIL_DOMAIN unset); skipping');
    return null;
  }

  // Anchor the match on the "@" boundary so a domain configured without a leading "@"
  // (e.g. "app.acme.com") can't spuriously match a different domain like "x@evilapp.acme.com".
  const suffix = platformDomain.startsWith('@') ? platformDomain : `@${platformDomain}`;

  const allRecipients = [
    ...(Array.isArray(to) ? to : to ? [to] : []),
    ...(Array.isArray(cc) ? cc : cc ? [cc] : []),
    ...(Array.isArray(bcc) ? bcc : bcc ? [bcc] : []),
  ];

  for (const addressObj of allRecipients) {
    for (const addr of addressObj.value) {
      if (addr.address && addr.address.endsWith(suffix)) {
        return addr.address.toLowerCase();
      }
    }
  }

  return null;
}

/**
 * Extract sender email address from the "From" field
 *
 * @param from - Email address object(s) from parsed email
 * @returns Sender email address or null if not found
 */
export function extractSenderEmail(from: EmailAddress | EmailAddress[] | undefined): string | null {
  if (!from) return null;

  const addresses = Array.isArray(from) ? from : [from];

  if (addresses.length > 0 && addresses[0].value.length > 0) {
    return addresses[0].value[0].address?.toLowerCase() || null;
  }

  return null;
}

/**
 * Extract all email addresses from an AddressObject
 *
 * @param addressObj - Email address object(s)
 * @returns Array of email addresses
 */
export function extractEmails(addressObj: EmailAddress | EmailAddress[] | undefined): string[] {
  if (!addressObj) return [];

  const addresses = Array.isArray(addressObj) ? addressObj : [addressObj];
  const emails: string[] = [];

  for (const addr of addresses) {
    for (const value of addr.value) {
      if (value.address) {
        emails.push(value.address.toLowerCase());
      }
    }
  }

  return emails;
}

/**
 * Validate that the sender is authorized to send to the platform email
 *
 * @param parsedEmail - Parsed email object
 * @param userRepository - User repository for database queries
 * @param platformDomain - Optional custom platform domain
 * @returns ValidatedSender with user and organization info, or null if unauthorized
 */
export async function validateSenderAuthorization(
  parsedEmail: ParsedEmailObject,
  userRepository: IUserRepository,
  platformDomain?: string
): Promise<ValidatedSender | null> {
  // Extract platform email from "To", "CC", or "BCC" fields
  const platformEmail = extractPlatformEmail(parsedEmail.to, parsedEmail.cc, parsedEmail.bcc, platformDomain);
  if (!platformEmail) {
    Logger.warn('No platform email address found in To, CC, or BCC fields');
    return null;
  }

  // Extract sender email from "From" field
  const senderEmail = extractSenderEmail(parsedEmail.from);
  if (!senderEmail) {
    Logger.warn('No sender email address found in From field');
    return null;
  }

  Logger.info(`Validating sender: ${senderEmail} to platform: ${platformEmail}`);

  // Find user by platform email address
  const user = await userRepository.findOne({ platformEmailAddress: platformEmail });

  if (!user) {
    Logger.warn(`No user found with platform email: ${platformEmail}`);
    return null;
  }

  Logger.info(`User found: ${user.id}, checking authorization for sender: ${senderEmail}`);

  // Check if sender is in authorized list
  const authorizedEmails = user.authorizedEmailAddresses || [];
  const isAuthorized = authorizedEmails.some((email: string) => email.toLowerCase() === senderEmail);

  if (!isAuthorized) {
    Logger.warn(`Unauthorized sender: ${senderEmail} not in authorized list: ${authorizedEmails.join(', ')}`);
    return null;
  }

  Logger.info(`Sender authorized: ${senderEmail}`);

  return {
    userId: user.id.toString(),
    organizationId: user.organizationId?.toString(),
    platformEmail,
    senderEmail,
  };
}

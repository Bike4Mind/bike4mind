/**
 * Email Ingestion Service
 *
 * Vendor-agnostic email processing service for ingesting emails into the platform.
 * Handles sender validation, email storage, attachment processing, and body conversion.
 *
 * @see README.md for integration guide and usage examples
 */

export { processIngestedEmail } from './processIngestedEmail';
export { processAttachments } from './processAttachments';
export { processEmailBody } from './processEmailBody';
export { validateSenderAuthorization, extractPlatformEmail, extractSenderEmail, extractEmails } from './validateSender';
export {
  authenticateSender,
  readSenderAuthenticationHeaders,
  parseAuthenticationResults,
  SES_AUTHSERV_ID,
} from './authenticateSender';
export type { SenderAuthenticationVerdict, SenderAuthenticationRejection, HeaderLine } from './authenticateSender';

export type {
  ParsedEmailObject,
  EmailAddress,
  EmailAttachment,
  IEmailParserAdapter,
  IStorageAdapter,
  EmailIngestionAdapters,
  ValidatedSender,
  SenderAuthenticationHeaders,
  ProcessedAttachment,
  ProcessedEmailBody,
  IngestedEmailResult,
} from './types';

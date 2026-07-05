import type {
  IUserRepository,
  IFabFileRepository,
  IAdminSettingsRepository,
  IIngestedEmailRepository,
} from '@bike4mind/common';
import { z } from 'zod';

// IIngestedEmailDocument is imported from @bike4mind/common; vendors should use the common interface.

/**
 * Vendor-agnostic parsed email object
 * Maps from mailparser's ParsedMail or any other email parser
 */
export interface ParsedEmailObject {
  // Message identifiers
  messageId?: string;
  inReplyTo?: string;
  references?: string | string[];

  // Headers
  from?: EmailAddress | EmailAddress[];
  to?: EmailAddress | EmailAddress[];
  cc?: EmailAddress | EmailAddress[];
  bcc?: EmailAddress | EmailAddress[];
  subject?: string;
  date?: Date;

  // Content
  text?: string; // Plain text body
  html?: string; // HTML body

  // Attachments
  attachments?: EmailAttachment[];
}

/**
 * Email address object (compatible with mailparser)
 */
export interface EmailAddress {
  value: Array<{
    address?: string;
    name?: string;
  }>;
  text?: string;
}

/**
 * Email attachment object (compatible with mailparser)
 */
export interface EmailAttachment {
  filename?: string;
  contentType?: string;
  contentDisposition?: string;
  size: number;
  content: Buffer;
  related?: boolean; // Indicates embedded content (e.g., inline images with cid: references)
}

/**
 * Email parser adapter interface
 * Vendors can implement this with mailparser, nodemailer, or custom parsers
 */
export interface IEmailParserAdapter {
  /**
   * Parse raw email buffer into standardized ParsedEmailObject
   */
  parse: (rawEmail: Buffer) => Promise<ParsedEmailObject>;
}

/**
 * Storage adapter interface for file operations
 */
export interface IStorageAdapter {
  /**
   * Upload file content to storage
   */
  upload: (
    filepath: string,
    content: string | Buffer,
    options?: { ContentType?: string; ContentLength?: number }
  ) => Promise<string>;

  /**
   * Generate signed URL for file access
   */
  generateSignedUrl: (filepath: string, expireInSeconds: number, type?: 'get' | 'put') => Promise<string>;
}

/**
 * Queue adapter interface for sending messages to analysis queue
 */
export interface IQueueAdapter {
  /**
   * Send a message to the analysis queue
   */
  sendMessage: (message: Record<string, unknown>) => Promise<string>;
}

/**
 * Dependency injection adapters for email ingestion service
 */
export interface EmailIngestionAdapters {
  db: {
    users: IUserRepository;
    ingestedEmails: IIngestedEmailRepository;
    fabFiles: IFabFileRepository;
    adminSettings: IAdminSettingsRepository;
  };
  storage: IStorageAdapter;
  /**
   * Optional queue adapter for triggering AI analysis
   * If provided, email ID will be sent to analysis queue after successful ingestion
   */
  queue?: IQueueAdapter;
}

/**
 * Result of sender validation
 */
export interface ValidatedSender {
  userId: string;
  organizationId?: string;
  platformEmail: string;
  senderEmail: string;
}

/**
 * Result of attachment processing
 */
export interface ProcessedAttachment {
  filename: string;
  mimeType: string;
  size: number;
  fabFileId?: string;
}

/**
 * Result of email body processing
 */
export interface ProcessedEmailBody {
  bodyMarkdown?: string;
  bodyFabFileId?: string;
}

/**
 * Complete result of email ingestion
 */
export interface IngestedEmailResult {
  emailId: string;
  messageId: string;
  threadId: string;
  attachments: ProcessedAttachment[];
  bodyFabFileCreated: boolean;
  alreadyProcessed: boolean;
}

// ============================================
// Zod Schemas for Runtime Validation
// ============================================

/**
 * Zod schema for process ingested email options
 */
export const processIngestedEmailOptionsSchema = z
  .object({
    platformDomain: z.string().optional(),
    isNewsletter: z.boolean().optional(),
  })
  .optional();

/**
 * Zod schema for attachment validation
 */
export const emailAttachmentSchema = z.object({
  filename: z.string().optional(),
  contentType: z.string().optional(),
  contentDisposition: z.string().optional(),
  size: z.number().min(0),
  content: z.instanceof(Buffer),
  related: z.boolean().optional(),
});

/**
 * Zod schema for parsed email validation
 */
export const parsedEmailObjectSchema = z.object({
  messageId: z.string().optional(),
  inReplyTo: z.string().optional(),
  references: z.union([z.string(), z.array(z.string())]).optional(),
  from: z.any().optional(), // Complex email address object
  to: z.any().optional(),
  cc: z.any().optional(),
  bcc: z.any().optional(),
  subject: z.string().optional(),
  date: z.date().optional(),
  text: z.string().optional(),
  html: z.string().optional(),
  attachments: z.array(emailAttachmentSchema).optional(),
});

/**
 * Zod schema for full processIngestedEmail call
 */
export const processIngestedEmailSchema = z.object({
  parsedEmail: parsedEmailObjectSchema,
  rawEmailS3Key: z.string().min(1, 'rawEmailS3Key cannot be empty'),
  options: processIngestedEmailOptionsSchema,
});

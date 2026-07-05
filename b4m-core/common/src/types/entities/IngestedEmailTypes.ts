import { IBaseRepository, IMongoDocument } from '.';

/**
 * Ingested Email - Email received via platform email address and processed
 */
export interface IIngestedEmail {
  id: string;

  // Email Identifiers
  messageId: string; // RFC 822 Message-ID
  inReplyTo?: string | null; // Parent email Message-ID
  references?: string[]; // Full thread chain
  threadId: string; // Conversation grouping

  // Email Headers
  from: string; // Sender email address
  to: string[]; // Recipient email addresses
  cc?: string[]; // CC recipients
  bcc?: string[]; // BCC recipients
  subject: string; // Email subject
  date: Date; // Email sent date

  // Email Content
  bodyText?: string | null; // Plain text body
  bodyHtml?: string | null; // HTML body
  bodyMarkdown?: string | null; // Cleaned markdown
  bodyS3Path?: string | null; // S3 path to stored markdown body
  bodyFabFileId?: string | null; // FabFile for substantial email bodies

  // Attachments & Links
  attachments?: IEmailAttachment[];
  scrapedLinks?: IScrapedLink[];

  // AI Analysis
  aiAnalysis?: IEmailAIAnalysis | null;

  // Privacy & Sharing
  visibilityLevel: 'private' | 'team' | 'organization' | 'custom';
  sharedWithTeams?: string[]; // Team IDs
  sharedWithUsers?: string[]; // User IDs
  embargoUntil?: Date | null; // Release date for team visibility

  // Metadata
  userId: string; // Owner of the ingested email
  organizationId?: string | null;
  platformEmailAddress?: string | null; // Platform email address used (e.g., "consumer.smith@app.example.com")
  rawEmailS3Key?: string | null; // S3 key for raw email

  // Flags
  isSpam?: boolean;
  isNewsletter?: boolean;
  requiresReview?: boolean;

  // Timestamps
  receivedAt: Date; // When platform received it
  ingestedAt: Date; // When processing completed
  createdAt: Date;
  updatedAt: Date;
}

export interface IEmailAttachment {
  filename: string;
  mimeType: string;
  size: number; // Size in bytes
  fabFileId?: string | null; // Reference to FabFile
  s3Path?: string | null; // S3 path to attachment
}

export interface IScrapedLink {
  url: string;
  title?: string | null;
  scrapedAt?: Date | null;
  fabFileId?: string | null; // Scraped content as FabFile
  failed?: boolean;
  failureReason?: string | null; // "Paywall", "Auth required", etc.
}

export interface IEmailAIAnalysis {
  summary?: string | null; // TL;DR summary
  entities?: {
    companies?: string[];
    people?: string[];
    products?: string[];
    technologies?: string[];
  };
  suggestedTags?: string[];
  sentiment?: 'positive' | 'neutral' | 'negative' | 'urgent' | null;
  actionItems?: IActionItem[];
  privacyRecommendation?: 'public' | 'team' | 'private' | null;
  embargoDetected?: boolean;
  analyzedAt?: Date;
  model?: string;
  tokensUsed?: {
    input: number;
    output: number;
  };
  costUSD?: number;
}

export interface IActionItem {
  description: string;
  deadline?: Date | null;
}

export interface IIngestedEmailDocument extends IIngestedEmail, IMongoDocument {}

export interface IIngestedEmailRepository extends IBaseRepository<IIngestedEmailDocument> {
  /**
   * Find email by RFC 822 Message-ID
   */
  findByMessageId(messageId: string): Promise<IIngestedEmailDocument | null>;

  /**
   * Find all emails in a conversation thread
   */
  findByThreadId(threadId: string, userId: string): Promise<IIngestedEmailDocument[]>;

  /**
   * Find user's emails with pagination
   */
  findByUserIdWithPagination(userId: string, limit: number, offset: number): Promise<IIngestedEmailDocument[]>;

  /**
   * Find emails visible to user (respecting privacy settings)
   */
  findVisibleToUser(userId: string, organizationId?: string): Promise<IIngestedEmailDocument[]>;

  /**
   * Release embargo (make email visible to team)
   */
  releaseEmbargo(emailId: string): Promise<void>;

  /**
   * Find embargoed emails ready for release
   */
  findEmbargoedEmailsReadyForRelease(): Promise<IIngestedEmailDocument[]>;

  /**
   * Find by platform email address
   */
  findByPlatformEmailAddress(platformEmailAddress: string): Promise<IIngestedEmailDocument[]>;
}

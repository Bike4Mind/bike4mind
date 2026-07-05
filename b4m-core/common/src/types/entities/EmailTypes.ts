import { IBaseRepository, IMongoDocument } from '.';
import { PaginatedResponse } from '../common';

// ================== ENUMS ==================

export enum EmailJobStatus {
  DRAFT = 'draft',
  SCHEDULED = 'scheduled',
  QUEUED = 'queued',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export enum EmailSendStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  SENT = 'sent',
  DELIVERED = 'delivered',
  OPENED = 'opened',
  CLICKED = 'clicked',
  BOUNCED = 'bounced',
  COMPLAINED = 'complained',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

/**
 * Overall status for reusable campaigns
 * Unlike EmailJobStatus which tracks processing state, this tracks send history
 */
export enum EmailJobOverallStatus {
  DRAFT = 'draft', // Never been sent
  SENDING = 'sending', // Currently sending
  COMPLETE = 'complete', // Last send completed successfully
  PARTIAL = 'partial', // Last send partially completed
  FAILED = 'failed', // Last send failed
}

export enum EmailCategory {
  MARKETING = 'marketing',
  PRODUCT_UPDATE = 'product_update',
  NEWSLETTER = 'newsletter',
  ANNOUNCEMENT = 'announcement',
  TRANSACTIONAL = 'transactional',
}

// ================== EMAIL TEMPLATE ==================

/**
 * Base interface for email template data
 */
export interface IEmailTemplate {
  name: string;
  slug: string; // unique identifier for programmatic access
  description?: string;
  subject: string; // supports variables like {{userName}}
  htmlContent: string; // HTML template with variables
  textContent?: string; // Plain text fallback
  category: EmailCategory;
  variables: string[]; // list of supported variables: ['userName', 'content', 'unsubscribeUrl']
  isActive: boolean;
  createdBy: string;
}

/**
 * Extends IEmailTemplate with MongoDB document properties
 */
export interface IEmailTemplateDocument extends IEmailTemplate, IMongoDocument {}

/**
 * Repository interface for email template operations
 */
export interface IEmailTemplateRepository extends IBaseRepository<IEmailTemplateDocument> {
  findBySlug: (slug: string) => Promise<IEmailTemplateDocument | null>;
  findActiveByCategory: (category: EmailCategory) => Promise<IEmailTemplateDocument[]>;
  listTemplates: (options: {
    page: number;
    limit: number;
    search?: string;
    category?: EmailCategory;
  }) => Promise<PaginatedResponse<IEmailTemplateDocument>>;
}

// ================== EMAIL JOB ==================

/**
 * Recipient filter for targeting email recipients
 */
export interface IEmailRecipientFilter {
  all?: boolean; // Send to all subscribers (legacy)
  allUsers?: boolean; // Send to all registered users with verified emails
  allSubscribers?: boolean; // Send to all newsletter subscribers
  userIds?: string[]; // Specific user IDs
  subscriberIds?: string[]; // Specific subscriber IDs
  specificEmails?: string[]; // Direct email addresses (not linked to user/subscriber)
  tags?: string[]; // Filter by tags (future use)
}

/**
 * Base interface for email job data
 */
export interface IEmailJob {
  name: string;
  templateId: string;
  subject?: string; // override template subject
  variables: Record<string, string>; // job-level variables
  category: EmailCategory;
  status: EmailJobStatus;

  // Reusable campaign status - tracks send history
  overallStatus: EmailJobOverallStatus;

  // Targeting
  recipientFilter?: IEmailRecipientFilter;
  recipientCount: number;

  // Test Mode - sends to test addresses instead of actual recipients
  isTestMode?: boolean;
  testEmailAddresses?: string[]; // emails to send to when in test mode

  // Scheduling
  scheduledAt?: Date;
  startedAt?: Date;
  completedAt?: Date;

  // Cumulative Progress/Analytics (across all sends)
  totalEmailsSent: number; // Total emails sent across all sends
  sentCount: number;
  failedCount: number;
  cancelledCount: number;
  openedCount: number;
  clickedCount: number;

  // Last send info
  lastSentAt?: Date;
  lastSentBy?: string;

  // Audit
  createdBy: string;
  startedBy?: string; // Who triggered the campaign (user ID or 'scheduler' for automated)
}

/**
 * Extends IEmailJob with MongoDB document properties
 */
export interface IEmailJobDocument extends IEmailJob, IMongoDocument {}

/**
 * Repository interface for email job operations
 */
export interface IEmailJobRepository extends IBaseRepository<IEmailJobDocument> {
  findByStatus: (status: EmailJobStatus) => Promise<IEmailJobDocument[]>;
  findDueScheduledJobs: () => Promise<IEmailJobDocument[]>;
  listJobs: (options: {
    page: number;
    limit: number;
    status?: EmailJobStatus;
    excludeTest?: boolean;
    startDate?: Date;
    endDate?: Date;
  }) => Promise<PaginatedResponse<IEmailJobDocument>>;
  incrementCounts: (
    id: string,
    field: 'sentCount' | 'failedCount' | 'cancelledCount' | 'openedCount' | 'clickedCount' | 'totalEmailsSent'
  ) => Promise<void>;
  incrementCountsBy: (
    id: string,
    field: 'sentCount' | 'failedCount' | 'cancelledCount' | 'openedCount' | 'clickedCount' | 'totalEmailsSent',
    amount: number
  ) => Promise<void>;
  updateOverallStatus: (id: string, status: EmailJobOverallStatus, updates?: Partial<IEmailJob>) => Promise<void>;
}

// ================== EMAIL SEND ATTEMPT ==================

/**
 * Recipient type for tracking purposes
 */
export type EmailRecipientType = 'user' | 'subscriber' | 'direct';

/**
 * Base interface for email send attempt data
 */
export interface IEmailSendAttempt {
  jobId: string;
  recipientId: string; // userId or subscriberId
  recipientType: EmailRecipientType;
  recipientEmail: string;

  status: EmailSendStatus;

  // Tracking
  trackingToken: string; // unique token for this send
  sentAt?: Date;
  openedAt?: Date;
  clickedAt?: Date;
  clickedLinks?: string[];

  // Test mode fields
  isTestEmail?: boolean; // Was this a test send?
  originalRecipient?: string; // If test, the original intended recipient email
  testSubjectIndicator?: boolean; // Whether [TEST] was added to subject

  // Send metadata
  sentBy?: string; // User who triggered this send
  renderedSubject?: string; // The rendered subject line
  renderedHtml?: string; // The rendered HTML content (stored for preview)

  // Error handling
  errorMessage?: string;
  retryCount: number;
}

/**
 * Extends IEmailSendAttempt with MongoDB document properties
 */
export interface IEmailSendAttemptDocument extends IEmailSendAttempt, IMongoDocument {}

/**
 * Repository interface for email send attempt operations
 */
export interface IEmailSendAttemptRepository extends IBaseRepository<IEmailSendAttemptDocument> {
  findByTrackingToken: (token: string) => Promise<IEmailSendAttemptDocument | null>;
  findByJob: (
    jobId: string,
    options: {
      page: number;
      limit: number;
      status?: EmailSendStatus;
      search?: string;
      excludeTest?: boolean;
      startDate?: Date;
      endDate?: Date;
    }
  ) => Promise<PaginatedResponse<IEmailSendAttemptDocument>>;
  updateStatus: (id: string, status: EmailSendStatus, updates?: Partial<IEmailSendAttempt>) => Promise<void>;
  markOpened: (trackingToken: string) => Promise<IEmailSendAttemptDocument | null>;
  recordClick: (trackingToken: string, link: string) => Promise<IEmailSendAttemptDocument | null>;
  getJobSummary: (jobId: string) => Promise<{
    total: number;
    pending: number;
    processing: number;
    sent: number;
    failed: number;
    cancelled: number;
    testEmails: {
      total: number;
      pending: number;
      processing: number;
      sent: number;
      failed: number;
      cancelled: number;
    };
  }>;
  cancelPendingAttempts: (jobId: string, userIds?: string[]) => Promise<number>;
}

// ================== EMAIL PREFERENCES ==================

/**
 * Base interface for email preferences data
 */
export interface IEmailPreferences {
  userId?: string;
  subscriberId?: string;
  email: string;

  // Per-category opt-out
  unsubscribedCategories: EmailCategory[];

  // Global unsubscribe
  globalUnsubscribe: boolean;

  // Token for secure unsubscribe links
  unsubscribeToken: string;

  unsubscribedAt?: Date;
}

/**
 * Extends IEmailPreferences with MongoDB document properties
 */
export interface IEmailPreferencesDocument extends IEmailPreferences, IMongoDocument {}

/**
 * Repository interface for email preferences operations
 */
export interface IEmailPreferencesRepository extends IBaseRepository<IEmailPreferencesDocument> {
  findByEmail: (email: string) => Promise<IEmailPreferencesDocument | null>;
  findByUnsubscribeToken: (token: string) => Promise<IEmailPreferencesDocument | null>;
  findOrCreate: (email: string, userId?: string, subscriberId?: string) => Promise<IEmailPreferencesDocument>;
  unsubscribeFromCategory: (email: string, category: EmailCategory) => Promise<void>;
  globalUnsubscribe: (email: string) => Promise<void>;
  resubscribe: (email: string, category?: EmailCategory) => Promise<void>;
}

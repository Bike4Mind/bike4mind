import { randomUUID } from 'crypto';
import { Logger } from '@bike4mind/observability';
import { UnauthorizedError } from '@bike4mind/utils';
import { validateSenderAuthorization, extractEmails } from './validateSender';
import { processAttachments } from './processAttachments';
import { processEmailBody } from './processEmailBody';
import {
  ParsedEmailObject,
  EmailIngestionAdapters,
  IngestedEmailResult,
  ValidatedSender,
  processIngestedEmailSchema,
} from './types';

/**
 * Generate a thread ID from message headers
 * Uses In-Reply-To or References if available, otherwise creates new from Message-ID
 */
function generateThreadId(parsedEmail: ParsedEmailObject): string {
  // If this is a reply, use the original message ID as thread ID
  if (parsedEmail.inReplyTo) {
    return parsedEmail.inReplyTo;
  }

  // If there are references, use the first one as thread ID
  if (parsedEmail.references) {
    const refs = Array.isArray(parsedEmail.references) ? parsedEmail.references : [parsedEmail.references];
    if (refs.length > 0) {
      return refs[0];
    }
  }

  // Otherwise, this is a new thread - use this message's ID
  return parsedEmail.messageId || `thread-${randomUUID()}`;
}

/**
 * Store parsed email in MongoDB (initial save without attachments/body processing)
 */
async function storeEmail(
  parsedEmail: ParsedEmailObject,
  validated: ValidatedSender,
  rawEmailS3Key: string,
  adapters: EmailIngestionAdapters
): Promise<string> {
  const threadId = generateThreadId(parsedEmail);
  const messageId = parsedEmail.messageId || `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Check if email already exists (idempotency for retries)
  const existingEmail = await adapters.db.ingestedEmails.findByMessageId(messageId);
  if (existingEmail) {
    Logger.info('Email already exists, returning existing ID:', existingEmail.id);
    return existingEmail.id;
  }

  const emailData = {
    // Email Identifiers
    messageId,
    inReplyTo: parsedEmail.inReplyTo,
    references: Array.isArray(parsedEmail.references)
      ? parsedEmail.references
      : parsedEmail.references
        ? [parsedEmail.references]
        : [],
    threadId,

    // Email Headers
    from: validated.senderEmail,
    to: extractEmails(parsedEmail.to),
    cc: extractEmails(parsedEmail.cc),
    bcc: extractEmails(parsedEmail.bcc),
    subject: parsedEmail.subject || '(No Subject)',
    date: parsedEmail.date || new Date(),

    // Email Content
    bodyText: parsedEmail.text || undefined,
    bodyHtml: parsedEmail.html || undefined,

    // Attachments (will be processed after initial storage)
    attachments: [],

    // Metadata
    userId: validated.userId,
    organizationId: validated.organizationId,
    platformEmailAddress: validated.platformEmail,
    rawEmailS3Key,

    // Timestamps
    receivedAt: parsedEmail.date || new Date(),
    ingestedAt: new Date(),

    // Privacy (default to private until AI analysis)
    visibilityLevel: 'private' as const,
  };

  Logger.info('Storing email in MongoDB', {
    messageId: emailData.messageId,
    threadId: emailData.threadId,
    userId: validated.userId,
  });

  const storedEmail = await adapters.db.ingestedEmails.create(emailData);

  Logger.info('Email stored successfully with ID:', storedEmail.id);

  return storedEmail.id;
}

/**
 * Main email ingestion orchestration
 *
 * This function coordinates the entire email ingestion process:
 * 1. Validates sender authorization
 * 2. Stores email metadata in database
 * 3. Processes attachments and uploads to fabFiles
 * 4. Processes email body and creates fabFile if substantial
 * 5. Updates email record with processed data
 *
 * @param parsedEmail - Parsed email object (vendor-agnostic)
 * @param rawEmailS3Key - S3 key or storage reference for raw email
 * @param adapters - Database and storage adapters
 * @param options - Optional configuration
 * @returns IngestedEmailResult with email ID and processing status
 */
export async function processIngestedEmail(
  parsedEmail: ParsedEmailObject,
  rawEmailS3Key: string,
  adapters: EmailIngestionAdapters,
  options?: {
    platformDomain?: string;
    isNewsletter?: boolean;
  }
): Promise<IngestedEmailResult> {
  processIngestedEmailSchema.parse({
    parsedEmail,
    rawEmailS3Key,
    options,
  });

  Logger.info('Starting email ingestion process');

  // 1. Validate sender authorization
  const validated = await validateSenderAuthorization(parsedEmail, adapters.db.users, options?.platformDomain);

  if (!validated) {
    throw new UnauthorizedError('Unauthorized sender or invalid platform email');
  }

  Logger.info(`Email authorized: ${validated.senderEmail} → ${validated.platformEmail}`);

  // 2. Store parsed email in MongoDB (initial save)
  const emailId = await storeEmail(parsedEmail, validated, rawEmailS3Key, adapters);

  // Check if email was already processed (from previous retry)
  const existingEmail = await adapters.db.ingestedEmails.findById(emailId);
  const alreadyProcessed =
    existingEmail && ((existingEmail.attachments?.length ?? 0) > 0 || existingEmail.bodyFabFileId);

  let processedAttachments: any[] = [];
  let bodyFabFileCreated = false;

  if (alreadyProcessed && existingEmail) {
    Logger.info('Email already processed (from previous attempt), skipping attachment/body processing');
    processedAttachments = existingEmail.attachments || [];
    bodyFabFileCreated = !!existingEmail.bodyFabFileId;
  } else {
    // 3. Process attachments and upload to fabFiles
    Logger.info('Processing attachments...');
    processedAttachments = await processAttachments(
      parsedEmail,
      validated.userId,
      parsedEmail.subject || '(No Subject)',
      {
        storage: adapters.storage,
        db: {
          fabFiles: adapters.db.fabFiles,
          adminSettings: adapters.db.adminSettings,
          users: adapters.db.users,
        },
      },
      validated.organizationId
    );

    // 4. Process email body and create fabFile if substantial
    Logger.info('Processing email body...');
    const bodyData = await processEmailBody(
      parsedEmail,
      validated.userId,
      emailId,
      options?.isNewsletter || false,
      {
        storage: adapters.storage,
        db: {
          fabFiles: adapters.db.fabFiles,
          adminSettings: adapters.db.adminSettings,
          users: adapters.db.users,
        },
      },
      validated.organizationId
    );

    // 5. Update email with fabFile information
    Logger.info('Updating email with fabFile references...');
    const updateData: any = {
      attachments: processedAttachments,
    };

    if (bodyData.bodyMarkdown !== undefined) {
      updateData.bodyMarkdown = bodyData.bodyMarkdown;
    }

    if (bodyData.bodyFabFileId) {
      updateData.bodyFabFileId = bodyData.bodyFabFileId;
      bodyFabFileCreated = true;
    }

    await adapters.db.ingestedEmails.update({ id: emailId, ...updateData });

    Logger.info(
      `Email updated with ${processedAttachments.length} attachments and ${bodyFabFileCreated ? 'body fabFile' : 'no body fabFile'}`
    );
  }

  Logger.info('Email ingestion complete', {
    emailId,
    attachments: processedAttachments.length,
    bodyFabFile: bodyFabFileCreated ? 'created' : 'skipped',
  });

  // 6. Trigger AI analysis if queue adapter is provided
  if (adapters.queue && !alreadyProcessed) {
    Logger.info('Triggering AI analysis via queue');
    try {
      const messageId = await adapters.queue.sendMessage({ emailId });
      Logger.info('AI analysis queued successfully', { messageId });
    } catch (error) {
      // Don't fail ingestion if queue fails - analysis can be retried later
      Logger.warn('Failed to queue AI analysis', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } else if (!adapters.queue) {
    Logger.info('No queue adapter provided, skipping AI analysis trigger');
  }

  return {
    emailId,
    messageId: parsedEmail.messageId || 'unknown',
    threadId: generateThreadId(parsedEmail),
    attachments: processedAttachments,
    bodyFabFileCreated,
    alreadyProcessed: !!alreadyProcessed,
  };
}

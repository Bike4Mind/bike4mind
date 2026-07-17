import { z } from 'zod';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { Resource } from 'sst';
import { QuestStartBodySchema } from '@bike4mind/services';
import {
  ContextTelemetrySchema,
  ContextTelemetryAlertsSchema,
  SRE_ANALYSIS_COMPLETED_EVENT,
  type SreFixRequest,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';

// Self-host has no EventBridge. Deliver email.send straight to the mailer, and route
// everything else to the SELF_HOST_EVENT_QUEUE for the background worker to consume
// (server/worker/eventDispatch.ts). These events feed async enrichment (naming,
// summaries, tags, memento embedding), so a delivery failure must degrade the feature,
// not 500 the caller - hence warn-and-drop, never throw.
async function publishSelfHost(eventName: string, detail: unknown): Promise<void> {
  const logger = new Logger({ metadata: { service: 'eventBus' } });

  if (eventName === 'email.send') {
    const { default: mailer } = await import('./mailer');
    const { to, subject, body, attachments } = detail as {
      to: string;
      subject: string;
      body: string;
      attachments?: { filename: string; content: string; contentType: string }[];
    };
    await mailer.sendEmail(to, {
      subject,
      html: body,
      attachments: attachments?.map(att => ({
        filename: att.filename,
        content: Buffer.from(att.content, 'base64'),
        contentType: att.contentType,
      })),
    });
    return;
  }

  const queueUrl = process.env.SELF_HOST_EVENT_QUEUE;
  if (!queueUrl) {
    logger.warn(`Self-host: SELF_HOST_EVENT_QUEUE unset; dropping event ${eventName} (enrichment will not run)`);
    return;
  }
  try {
    // Lazy import so modules that never publish don't pull the SQS client at load.
    const { sendToQueue } = await import('./sqs');
    await sendToQueue(queueUrl, { detailType: eventName, detail });
  } catch (error) {
    logger.warn(`Self-host: failed to enqueue event ${eventName}`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function createEventBuilder({
  getEventBusName,
  source,
  region,
}: {
  getEventBusName: () => string;
  source?: string;
  region?: string;
}) {
  return function event<EventName extends string, Schema extends z.ZodType>(eventName: EventName, schema: Schema) {
    return {
      publish: (detail: z.infer<typeof schema>) => {
        if (process.env.B4M_SELF_HOST === 'true') {
          return publishSelfHost(eventName, detail);
        }
        // Create client on each publish to ensure fresh AWS credentials
        // Lambda containers can stay warm for extended periods, causing module-level
        // clients to capture expired credentials. This was causing production failures:
        // "InvalidSignatureException: Signature expired" when publishing events.
        const eventBridge = new EventBridgeClient({
          region,
        });

        const command = new PutEventsCommand({
          Entries: [
            {
              Source: source || Resource.App.name,
              DetailType: eventName,
              Detail: JSON.stringify(detail),
              // Resolved lazily so Lambdas that don't publish to this bus
              // don't require it to be linked at module load time.
              EventBusName: getEventBusName(),
            },
          ],
        });

        return eventBridge.send(command);
      },
      schema,
    };
  };
}

const event = createEventBuilder({
  getEventBusName: () => Resource.AppEventBus.name,
});

const slackEvent = createEventBuilder({
  getEventBusName: () => Resource.SlackEventBus.name,
});

export const EmailEvents = {
  Send: event(
    'email.send',
    z.object({
      to: z.string(),
      subject: z.string(),
      body: z.string(),
      attachments: z
        .array(
          z.object({
            filename: z.string(),
            content: z.string(), // base64 encoded
            encoding: z.string().optional(),
            contentType: z.string(),
          })
        )
        .optional(),
    })
  ),
};

export const StripeEvents = {
  InvoicePaymentSucceeded: event(
    'stripe.invoice.payment_succeeded',
    z.object({
      invoiceId: z.string(),
      subscriptionId: z.string(),
    })
  ),
  CustomerSubscriptionUpdated: event(
    'stripe.cus.sub.updated',
    z.object({
      subscriptionId: z.string(),
    })
  ),
};

export const SessionEvents = {
  AutoName: event(
    'session.auto_name',
    z.object({
      sessionId: z.string(),
      userId: z.string(),
    })
  ),
  Summarize: event(
    'session.summarize',
    z.object({
      sessionId: z.string(),
      userId: z.string().optional(),
      callTagging: z.boolean().optional(),
      trigger: z.enum(['manual', 'project', 'earlyMilestone', 'contentGrowth', 'throttling']).optional(),
    })
  ),
  Tag: event(
    'session.tag',
    z.object({
      sessionId: z.string(),
      userId: z.string().optional(),
    })
  ),
  ContextSummarize: event(
    'session.context_summarize',
    z.object({
      sessionId: z.string(),
      verbatimWindowStartQuestId: z.string().regex(/^[0-9a-f]{24}$/, 'Must be a valid ObjectId hex string'), // Summary covers quests BEFORE this ID
    })
  ),
};

export const LLMEvents = {
  CompletionStart: event('completion.started', QuestStartBodySchema),
  // Slack-originated completions publish here - routed to slackQuestProcessor, not questProcessor
  SlackCompletionStart: slackEvent('slack.completion.started', QuestStartBodySchema),
  CompletionCompleted: event(
    'completion.completed',
    z.object({
      questId: z.string(),
      sessionId: z.string(),
      userId: z.string(),
      prompt: z.string(),
      model: z.string(),
    })
  ),
};

export const SpiderEvents = {
  Start: event(
    'spider.start',
    z.object({
      spiderJobId: z.string(),
      userId: z.string(),
      totalNotebooks: z.number(),
      operations: z.array(z.enum(['messageCount', 'curation', 'summarize', 'tags', 'embeddings'])),
      dryRun: z.boolean().optional().prefault(false),
    })
  ),
  Progress: event(
    'spider.progress',
    z.object({
      spiderJobId: z.string(),
      userId: z.string(),
      notebooksProcessed: z.number(),
      totalNotebooks: z.number(),
      currentOperation: z.string(),
      currentNotebookId: z.string().optional(),
      currentNotebookName: z.string().optional(),
    })
  ),
  Complete: event(
    'spider.complete',
    z.object({
      spiderJobId: z.string(),
      userId: z.string(),
      totalNotebooks: z.number(),
      stats: z.object({
        messageCountsUpdated: z.number(),
        notebooksCurated: z.number(),
        notebooksSummarized: z.number(),
        notebooksTagged: z.number(),
      }),
    })
  ),
  Error: event(
    'spider.error',
    z.object({
      spiderJobId: z.string(),
      userId: z.string(),
      error: z.string(),
      notebooksProcessed: z.number(),
      totalNotebooks: z.number(),
    })
  ),
};

export const PiHistoryAnalysisEvents = {
  Start: event(
    'pi.history.analysis.start',
    z.object({
      analysisJobId: z.string(),
      repoFullName: z.string(),
      userId: z.string(), // Who triggered it
    })
  ),
  Progress: event(
    'pi.history.analysis.progress',
    z.object({
      analysisJobId: z.string(),
      repoFullName: z.string(),
      phase: z.enum([
        'fetching_issues',
        'fetching_prs',
        'calculating_stats',
        'building_profiles',
        'extracting_keywords',
        'saving',
      ]),
      percentage: z.number(),
      itemsProcessed: z.number().optional(),
      totalItems: z.number().optional(),
    })
  ),
  Complete: event(
    'pi.history.analysis.complete',
    z.object({
      analysisJobId: z.string(),
      repoFullName: z.string(),
      stats: z.object({
        closedIssues: z.number(),
        mergedPRs: z.number(),
        contributors: z.number(),
      }),
    })
  ),
  Error: event(
    'pi.history.analysis.error',
    z.object({
      analysisJobId: z.string(),
      repoFullName: z.string(),
      error: z.string(),
      phase: z.string(),
    })
  ),
};

export const JiraHistoryAnalysisEvents = {
  Start: event(
    'pi.jira.history.analysis.start',
    z.object({
      analysisJobId: z.string(),
      projectKey: z.string(), // Jira project key, e.g. "PROJ"
      userId: z.string(),
    })
  ),
  Progress: event(
    'pi.jira.history.analysis.progress',
    z.object({
      analysisJobId: z.string(),
      projectKey: z.string(),
      phase: z.enum(['fetching_issues', 'calculating_stats', 'building_profiles', 'extracting_keywords', 'saving']),
      percentage: z.number(),
      itemsProcessed: z.number().optional(),
      totalItems: z.number().optional(),
    })
  ),
  Complete: event(
    'pi.jira.history.analysis.complete',
    z.object({
      analysisJobId: z.string(),
      projectKey: z.string(),
      stats: z.object({
        closedIssues: z.number(),
        contributors: z.number(),
      }),
    })
  ),
  Error: event(
    'pi.jira.history.analysis.error',
    z.object({
      analysisJobId: z.string(),
      projectKey: z.string(),
      error: z.string(),
      phase: z.string(),
    })
  ),
};

export const NotebookCurationEvents = {
  Start: event(
    'notebook.curation.start',
    z.object({
      sessionId: z.string(),
      userId: z.string(),
      curationJobId: z.string(),
      batchJobId: z.string().optional(), // For tracking batch operations
      batchIndex: z.number().optional(), // Position in batch (0-indexed)
      batchTotal: z.number().optional(), // Total sessions in batch
      curationType: z.enum(['transcript', 'executive_summary']).optional(),
      artifactTypes: z
        .array(
          z.enum(['CODE', 'REACT', 'MERMAID', 'RECHARTS', 'SVG', 'HTML', 'QUESTMASTER_PLAN', 'DEEP_RESEARCH', 'IMAGE'])
        )
        .optional(),
      exportFormat: z.enum(['markdown', 'txt', 'html']).optional(),
      customNotebookName: z.string().optional(),
    })
  ),
  Progress: event(
    'notebook.curation.progress',
    z.object({
      curationJobId: z.string(),
      sessionId: z.string(),
      userId: z.string(),
      stage: z.enum(['loading', 'extracting', 'generating', 'storing']),
      percentage: z.number(),
      message: z.string().optional(),
      messagesProcessed: z.number().optional(),
      totalMessages: z.number().optional(),
      artifactsFound: z.number().optional(),
    })
  ),
  Complete: event(
    'notebook.curation.complete',
    z.object({
      curationJobId: z.string(),
      sessionId: z.string(),
      userId: z.string(),
      curatedFileId: z.string(),
      artifactCount: z.number(),
      messageCount: z.number(),
      tokensProcessed: z.number(),
      curationType: z.enum(['transcript', 'executive_summary']).optional(),
      exportFormat: z.enum(['markdown', 'txt', 'html']).optional(),
      artifactTypes: z
        .array(
          z.enum(['CODE', 'REACT', 'MERMAID', 'RECHARTS', 'SVG', 'HTML', 'QUESTMASTER_PLAN', 'DEEP_RESEARCH', 'IMAGE'])
        )
        .optional(),
    })
  ),
  Error: event(
    'notebook.curation.error',
    z.object({
      curationJobId: z.string(),
      sessionId: z.string(),
      userId: z.string(),
      error: z.string(),
      stage: z.enum(['loading', 'extracting', 'generating', 'storing']),
    })
  ),
};

export const TelemetryEvents = {
  Alert: event(
    'telemetry.alert',
    z.object({
      telemetry: ContextTelemetrySchema,
      alertConfig: ContextTelemetryAlertsSchema,
      requestId: z.string().optional(), // Quest ID for correlation
    })
  ),
};

export const SreEvents = {
  // Diagnostician -> Surgeon handoff. Routed to sreFixQueue by an EventBridge rule
  // (infra/eventBus.ts) so additional consumers (audit, metrics) can attach without
  // touching the analysis handler. The strict payload schema lives with the consumer
  // (queueHandlers/sreFix.ts); publish-side stays typed via SreFixRequest.
  AnalysisCompleted: event(
    SRE_ANALYSIS_COMPLETED_EVENT,
    z.custom<SreFixRequest>((v: unknown) => typeof v === 'object' && v !== null)
  ),
};

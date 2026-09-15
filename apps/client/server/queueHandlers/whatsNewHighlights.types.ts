import { z } from 'zod';

/**
 * Payload schema for the What's New Highlights queue
 */
export const WhatsNewHighlightsPayloadSchema = z.object({
  /** Unique ID for tracking this generation request */
  correlationId: z.string(),
  /** Environment where highlights are being generated */
  environment: z.enum(['dev', 'production']),
  /** Start date for modal query (YYYY-MM-DD format) */
  startDate: z.string().optional(),
  /** End date for modal query (YYYY-MM-DD format) */
  endDate: z.string().optional(),
  /** Slack channel ID to post highlights to */
  slackChannelId: z.string().optional(),
  /** Slack team/workspace ID */
  slackTeamId: z.string().optional(),
  /** Whether this was triggered manually (vs cron) */
  manualTrigger: z.boolean().optional(),
});

export type WhatsNewHighlightsPayload = z.infer<typeof WhatsNewHighlightsPayloadSchema>;

/**
 * Configuration for highlights generation stored in AdminSettings
 */
export interface WhatsNewHighlightsConfig {
  /** Whether weekly highlights generation is enabled */
  enabled: boolean;
  /** Slack channel ID to post highlights to */
  slackChannelId: string;
  /** Slack team/workspace ID */
  slackTeamId: string;
  /** LLM model to use for summarization */
  llmModel?: string;
  /** Custom prompt template (uses default if not set) */
  promptTemplate?: string;
  /** Whether to attach raw markdown file to Slack message */
  attachMarkdownFile?: boolean;
  /** Last time highlights were generated */
  lastRunAt?: string;
  /** Last correlation ID */
  lastCorrelationId?: string;
  /** Last generated highlights content (for preview) */
  lastHighlights?: string;
  /** Last generation status */
  lastStatus?: 'success' | 'failed' | 'no_modals';
}

/**
 * Modal data structure for highlights generation
 */
export interface ModalForHighlights {
  _id: string;
  title: string;
  subtitle: string;
  description: string;
  createdAt: Date;
  startDate?: string;
  priority?: number;
}

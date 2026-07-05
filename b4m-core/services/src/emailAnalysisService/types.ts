import { z } from 'zod';
import type { IIngestedEmailDocument } from '@bike4mind/common';

/**
 * Email analysis input - extracted from IngestedEmail for LLM analysis
 */
export interface EmailAnalysisInput {
  from: string;
  to: string[];
  subject: string;
  bodyMarkdown?: string;
  bodyText?: string;
  bodyHtml?: string;
  attachments?: Array<{
    filename: string;
    mimeType: string;
    size: number;
  }>;
  date: Date;
}

/**
 * Entity extraction results
 */
export interface EmailEntities {
  companies: string[];
  people: string[];
  products: string[];
  technologies: string[];
}

/**
 * Action item extracted from email
 */
export interface EmailActionItem {
  description: string;
  deadline?: Date;
}

/**
 * Complete AI analysis result - matches IngestedEmailModel.aiAnalysis schema
 */
export interface EmailAnalysisResult {
  summary: string;
  entities: EmailEntities;
  sentiment: 'positive' | 'neutral' | 'negative' | 'urgent';
  actionItems: EmailActionItem[];
  privacyRecommendation: 'public' | 'team' | 'private';
  embargoDetected: boolean;
  suggestedTags: string[];
  tokensUsed?: {
    input: number;
    output: number;
  };
}

/**
 * Raw LLM response schema for parsing JSON output
 */
export const llmAnalysisResponseSchema = z.object({
  summary: z.string().min(1, 'Summary cannot be empty'),
  entities: z.object({
    companies: z.array(z.string()).prefault([]),
    people: z.array(z.string()).prefault([]),
    products: z.array(z.string()).prefault([]),
    technologies: z.array(z.string()).prefault([]),
  }),
  sentiment: z.enum(['positive', 'neutral', 'negative', 'urgent']),
  actionItems: z
    .array(
      z.object({
        description: z.string(),
        deadline: z.string().optional(), // ISO date string from LLM
      })
    )
    .prefault([]),
  privacyRecommendation: z.enum(['public', 'team', 'private']),
  embargoDetected: z.boolean().prefault(false),
  suggestedTags: z.array(z.string()).prefault([]),
});

export type LLMAnalysisResponse = z.infer<typeof llmAnalysisResponseSchema>;

/**
 * Options for email analysis
 */
export interface EmailAnalysisOptions {
  /**
   * Custom meta-prompt template (overrides default)
   */
  metaPrompt?: string;

  /**
   * LLM model to use (defaults to Claude 3.5 Sonnet)
   */
  model?: string;

  /**
   * Temperature for LLM generation
   */
  temperature?: number;

  /**
   * Additional context for analysis
   */
  context?: {
    userEmail?: string;
    organizationName?: string;
    projectName?: string;
  };
}

/**
 * Convert IngestedEmailDocument to EmailAnalysisInput
 */
export function emailDocumentToAnalysisInput(email: IIngestedEmailDocument): EmailAnalysisInput {
  return {
    from: email.from,
    to: email.to,
    subject: email.subject,
    bodyMarkdown: email.bodyMarkdown || undefined,
    bodyText: email.bodyText || undefined,
    bodyHtml: email.bodyHtml || undefined,
    attachments: email.attachments?.map(att => ({
      filename: att.filename,
      mimeType: att.mimeType,
      size: att.size,
    })),
    date: email.date,
  };
}

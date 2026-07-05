/**
 * Email Analysis Service
 *
 * AI-powered email analysis service that extracts structured information from emails:
 * - Summary generation
 * - Entity extraction (companies, people, products, technologies)
 * - Sentiment analysis
 * - Action item detection
 * - Privacy recommendation
 * - Embargo detection
 * - Tag generation
 *
 * @see README.md for integration guide and usage examples
 */

export { analyzeEmail } from './analyzeEmail';
export type { EmailAnalysisAdapters, ILLMAdapter } from './analyzeEmail';

export { DEFAULT_EMAIL_ANALYSIS_PROMPT, TEMPLATE_VARIABLES } from './defaultPrompt';
export type { TemplateVariable } from './defaultPrompt';

export { buildPrompt, buildTemplateVariables, substituteVariables } from './templateEngine';
export type { TemplateVariables } from './templateEngine';

export {
  emailDocumentToAnalysisInput,
  llmAnalysisResponseSchema,
  type EmailAnalysisInput,
  type EmailAnalysisResult,
  type EmailAnalysisOptions,
  type EmailEntities,
  type EmailActionItem,
  type LLMAnalysisResponse,
} from './types';

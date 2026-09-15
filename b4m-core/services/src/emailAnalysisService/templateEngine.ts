import { EmailAnalysisInput } from './types';

/**
 * Sanitize email content to prevent prompt injection attacks
 *
 * Protections:
 * - Normalizes Unicode to prevent homoglyph attacks (e.g., fullwidth "ＳＹＳＴＥＭ")
 * - Filters common prompt injection patterns
 * - Truncates to 10,000 characters max
 */
function sanitizeEmailContent(content: string): string {
  if (!content) return '';

  // Normalize Unicode to prevent homoglyph attacks
  // NFKD = Compatibility Decomposition (converts fullwidth/special chars to ASCII equivalents)
  // Then remove combining diacritical marks to get base characters
  const normalized = content.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');

  return (
    normalized
      // Remove common prompt injection patterns
      .replace(/IGNORE\s+PREVIOUS\s+INSTRUCTIONS/gi, '[FILTERED]')
      .replace(/IGNORE\s+ALL\s+PREVIOUS/gi, '[FILTERED]')
      .replace(/SYSTEM:/gi, '[FILTERED]')
      .replace(/ASSISTANT:/gi, '[FILTERED]')
      .replace(/USER:/gi, '[FILTERED]')
      .replace(/You\s+are\s+now/gi, '[FILTERED]')
      .replace(/Disregard\s+all/gi, '[FILTERED]')
      // Truncate to max length
      .substring(0, 10000)
  );
}

/**
 * Template variables that can be substituted in the meta-prompt
 */
export interface TemplateVariables {
  from: string;
  to: string;
  subject: string;
  bodyMarkdown: string;
  attachmentCount: string;
  attachmentNames: string;
  currentDate: string;
  userEmail?: string;
}

/**
 * Build template variables from email analysis input
 */
export function buildTemplateVariables(email: EmailAnalysisInput, options?: { userEmail?: string }): TemplateVariables {
  const attachmentCount = email.attachments?.length || 0;
  const attachmentNames =
    email.attachments && email.attachments.length > 0 ? email.attachments.map(att => att.filename).join(', ') : 'None';

  // Use bodyMarkdown if available, otherwise fallback to bodyText or bodyHtml
  let bodyContent = email.bodyMarkdown || email.bodyText || '';

  // If only HTML is available, use it (LLM can parse HTML reasonably well)
  if (!bodyContent && email.bodyHtml) {
    bodyContent = email.bodyHtml;
  }

  // Sanitize email content before using in template to prevent prompt injection
  const sanitizedBody = sanitizeEmailContent(bodyContent);

  return {
    from: email.from,
    to: email.to.join(', '),
    subject: email.subject,
    bodyMarkdown: sanitizedBody,
    attachmentCount: attachmentCount.toString(),
    attachmentNames,
    currentDate: new Date().toISOString(),
    userEmail: options?.userEmail || email.to[0] || 'unknown',
  };
}

/**
 * Substitute template variables in a prompt string
 *
 * Replaces {{variableName}} with actual values from the variables object
 *
 * @param template - The template string with {{variableName}} placeholders
 * @param variables - Object containing variable values
 * @returns Prompt string with all variables substituted
 */
export function substituteVariables(template: string, variables: TemplateVariables): string {
  let result = template;

  // Replace each variable in the template
  for (const [key, value] of Object.entries(variables)) {
    const placeholder = `{{${key}}}`;
    const replacement = value || '';

    // Use global replacement to handle multiple occurrences
    result = result.split(placeholder).join(replacement);
  }

  return result;
}

/**
 * Build the final prompt by substituting variables into the template
 *
 * @param template - Meta-prompt template with placeholders
 * @param email - Email data to analyze
 * @param options - Optional context (userEmail, etc.)
 * @returns Complete prompt ready for LLM
 */
export function buildPrompt(template: string, email: EmailAnalysisInput, options?: { userEmail?: string }): string {
  const variables = buildTemplateVariables(email, options);
  return substituteVariables(template, variables);
}

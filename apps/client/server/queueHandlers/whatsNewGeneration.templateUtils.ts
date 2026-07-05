import Handlebars from 'handlebars';
import { validateTemplate } from './whatsNewGeneration.templateConstants';

// Re-export constants and validation functions for backwards compatibility
export {
  ALLOWED_TEMPLATE_VARIABLES,
  TEMPLATE_VARIABLE_DOCS,
  validateTemplateVariables,
  containsInjectionPatterns,
  hasOutputFormatInstruction,
  validateTemplate,
  getDefaultTemplateString,
} from './whatsNewGeneration.templateConstants';

/**
 * Escapes and sanitizes template variable content to prevent injection
 * @param content - Raw content to escape
 * @param maxLength - Maximum allowed length
 * @returns Escaped and truncated content
 */
export function escapeVariableContent(content: string, maxLength: number = 5000): string {
  if (!content) return '';

  let escaped = content.slice(0, maxLength);

  // Remove potential injection patterns
  escaped = escaped
    .replace(/\{\{/g, '{ {') // Break Handlebars syntax
    .replace(/\}\}/g, '} }')
    .replace(/<\|im_start\|>/g, '') // Remove ChatML markers
    .replace(/<\|im_end\|>/g, '')
    .replace(/\[INST\]/g, '') // Remove LLaMA markers
    .replace(/\[\/INST\]/g, '');

  return escaped.trim();
}

/**
 * Escapes all variables in the template parameters
 * @param params - Raw template parameters
 * @returns Sanitized parameters safe for template rendering
 */
export function escapeTemplateVariables(params: {
  styleExamples: string;
  releaseTag: string;
  releaseBody: string;
  pullRequests: string;
  commits: string;
  changelogExcerpt: string;
}): Record<string, string> {
  return {
    styleExamples: escapeVariableContent(params.styleExamples, 3000),
    releaseTag: escapeVariableContent(params.releaseTag, 100),
    releaseBody: escapeVariableContent(params.releaseBody, 2000),
    pullRequests: escapeVariableContent(params.pullRequests, 2000),
    commits: escapeVariableContent(params.commits, 2000),
    changelogExcerpt: escapeVariableContent(params.changelogExcerpt, 1000),
  };
}

/**
 * Renders a custom template with provided parameters
 * @param template - Handlebars template string
 * @param params - Variables to inject into template
 * @returns Rendered prompt string
 */
export function renderTemplate(
  template: string,
  params: {
    styleExamples: string;
    releaseTag: string;
    releaseBody: string;
    pullRequests: string;
    commits: string;
    changelogExcerpt: string;
  }
): string {
  try {
    const validation = validateTemplate(template);
    if (!validation.isValid) {
      throw new Error(`Template validation failed: ${validation.errors.join(', ')}`);
    }

    const escapedParams = escapeTemplateVariables(params);

    const compiledTemplate = Handlebars.compile(template, {
      noEscape: false, // Enable HTML escaping
      strict: true, // Throw on undefined variables
    });

    return compiledTemplate(escapedParams);
  } catch (error) {
    throw new Error(`Template rendering failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

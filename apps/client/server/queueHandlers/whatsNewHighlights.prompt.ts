import type { ModalForHighlights } from './whatsNewHighlights.types';

/**
 * Template variables available for custom prompt templates
 */
export const HIGHLIGHTS_TEMPLATE_VARIABLES = {
  dateRangeStart: 'Start date of the highlights period (e.g., "Jan 31, 2026")',
  dateRangeEnd: 'End date of the highlights period (e.g., "Feb 7, 2026")',
  modalCount: "Number of What's New modals being summarized",
  modalsFormatted: 'Formatted list of all modals with titles, subtitles, descriptions, and dates',
  exampleFormat: 'Example highlights format showing the expected output structure',
} as const;

/** List of allowed template variable names */
const ALLOWED_TEMPLATE_VARIABLES = Object.keys(HIGHLIGHTS_TEMPLATE_VARIABLES);

/**
 * Patterns that indicate potential prompt injection attempts
 * Reused from liveopsTriagePrompt.ts for consistency
 */
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|above|prior)\s+instructions?/i,
  /disregard\s+(all\s+)?(previous|above|prior)\s+instructions?/i,
  /forget\s+(all\s+)?(previous|above|prior)\s+instructions?/i,
  /new\s+instructions?:/i,
  /system\s*:\s*you\s+are/i,
  /override\s+instructions?/i,
  /\[INST\]/i, // LLaMA instruction markers
  /<\|im_start\|>/i, // ChatML markers
  /{{system}}/i,
  /{{user}}/i,
];

/**
 * Validates that a template only uses allowed variables
 * @param template - The template string to validate
 * @returns Array of invalid variables found, or empty array if valid
 */
export function validateTemplateVariables(template: string): string[] {
  const variablePattern = /\{\{(\w+)\}\}/g;
  const matches = Array.from(template.matchAll(variablePattern));
  const invalidVars: string[] = [];

  for (const match of matches) {
    const varName = match[1];
    if (!ALLOWED_TEMPLATE_VARIABLES.includes(varName)) {
      invalidVars.push(varName);
    }
  }

  return invalidVars;
}

/**
 * Checks if template contains potential prompt injection patterns
 * @param template - The template string to check
 * @returns true if suspicious patterns found, false otherwise
 */
export function containsInjectionPatterns(template: string): boolean {
  return INJECTION_PATTERNS.some(pattern => pattern.test(template));
}

/**
 * Validates a custom highlights template before saving
 * @param template - The template to validate
 * @returns Object with isValid flag and error messages
 */
export function validateHighlightsTemplate(template: string): {
  isValid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // Check length
  if (template.length < 50) {
    errors.push('Template must be at least 50 characters');
  }
  if (template.length > 10000) {
    errors.push('Template cannot exceed 10,000 characters');
  }

  // Check for invalid variables
  const invalidVars = validateTemplateVariables(template);
  if (invalidVars.length > 0) {
    errors.push(
      `Invalid template variables: ${invalidVars.join(', ')}. Allowed variables are: ${ALLOWED_TEMPLATE_VARIABLES.join(', ')}`
    );
  }

  // Check for injection patterns
  if (containsInjectionPatterns(template)) {
    errors.push('Template contains suspicious patterns that could be prompt injection attempts');
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Escapes potential prompt injection patterns in text
 * Used to sanitize modal content before including in prompt
 * Patterns match INJECTION_PATTERNS for consistency
 */
export function escapeHighlightsContent(text: string): string {
  return (
    text
      // Match all patterns from INJECTION_PATTERNS
      .replace(/ignore\s+(all\s+)?(previous|above|prior)\s+instructions?/gi, '[filtered]')
      .replace(/disregard\s+(all\s+)?(previous|above|prior)\s+instructions?/gi, '[filtered]')
      .replace(/forget\s+(all\s+)?(previous|above|prior)\s+instructions?/gi, '[filtered]')
      .replace(/new\s+instructions?:/gi, '[filtered]')
      .replace(/system\s*:\s*you\s+are/gi, '[filtered]')
      .replace(/override\s+instructions?/gi, '[filtered]')
      .replace(/\[INST\]/gi, '[filtered]') // LLaMA instruction markers
      .replace(/<\|im_start\|>/gi, '[filtered]') // ChatML markers
      .replace(/\{\{system\}\}/gi, '[filtered]')
      .replace(/\{\{user\}\}/gi, '[filtered]')
      // Additional patterns for modal content
      .replace(/you\s+are\s+now/gi, '[filtered]')
      .replace(/\[SYSTEM\]/gi, '[filtered]')
      .replace(/output\s*:/gi, '[filtered]')
      .trim()
  );
}

/**
 * Example highlights format to guide the LLM
 * Based on actual highlights files from planning/
 */
const EXAMPLE_HIGHLIGHTS_FORMAT = `
# What's New - Weekly Highlights
**January 31 - February 7, 2026**

---

## This Week's Major Improvements

This week brought powerful integration enhancements across GitHub, Slack, and LinkedIn, plus AI-powered code navigation tools and improved context understanding. Here are the highlights from 3 releases:

---

## GitHub & Slack Integration

### GitHub-Slack Notifications (Feb 7)
- **Real-time GitHub updates in Slack** - Receive GitHub notifications directly in your Slack workspace
- **Streamlined collaboration** - No more switching between apps to stay updated on code activity
- **Impact**: Faster response to GitHub events, improved team coordination

### Org-level Slack Integration (Feb 7)
- **Self-service OAuth setup** - Admins can connect entire organizations to Slack with one click
- **Simplified onboarding** - No more individual workspace connections
- **Impact**: Faster setup, consistent Slack integration across teams

---

## AI Capabilities

### Find Definition Tool (Feb 7)
- **Cross-language definition lookup** - AI can find function and class definitions across programming languages
- **Language-agnostic search** - Works with multiple codebases and languages
- **Impact**: Faster code navigation, improved developer productivity

---

## TL;DR - This Week at a Glance

**GitHub-Slack**: Real-time GitHub notifications in Slack, org-level integration
**AI Tools**: Cross-language definition finder, improved context understanding
**Impact**: Seamless GitHub-Slack integration, smarter AI conversations

---

*All improvements work automatically—zero configuration required for users to benefit.*
`.trim();

/**
 * Default prompt template for highlights generation
 * Uses {{variable}} syntax for substitution
 */
const DEFAULT_HIGHLIGHTS_TEMPLATE = `
You are a technical writer creating a weekly highlights summary for a B2B SaaS product.

## Your Task
Analyze the following What's New announcements from the past week and create a concise, engaging weekly highlights summary.

## Input: What's New Modals from This Week
Date Range: {{dateRangeStart}} to {{dateRangeEnd}}
Number of Announcements: {{modalCount}}

{{modalsFormatted}}

## Output Format
Create a highlights summary following this exact format:

{{exampleFormat}}

## Guidelines
1. **Group by Category**: Organize features into logical categories (e.g., "GitHub Integration", "Slack Features", "AI Capabilities", "Developer Tools", "UI/UX")
2. **Extract Key Points**: For each feature, include:
   - A bold headline describing the feature
   - 1-2 bullet points explaining what it does
   - An "Impact" statement describing the user benefit
3. **Include Dates**: Add the date (e.g., "Feb 7") after each section header
4. **TL;DR Section**: Create a brief summary at the end with one-line descriptions
5. **Tone**: Professional but friendly, focus on user benefits
6. **Length**: Aim for 400-800 words total

## Critical Instructions
- DO NOT make up features - only include what's mentioned in the modals
- DO NOT include internal/technical changes that don't affect users
- If features are related, group them together
- Use consistent formatting with markdown headers and bullet points
- End with a positive closing statement

Now generate the weekly highlights summary:
`.trim();

/**
 * Get the default highlights prompt template
 */
export function getDefaultHighlightsTemplate(): string {
  return DEFAULT_HIGHLIGHTS_TEMPLATE;
}

/**
 * Format modals for inclusion in the prompt
 */
function formatModalsForPrompt(modals: ModalForHighlights[]): string {
  return modals
    .map((modal, index) => {
      const date = new Date(modal.createdAt).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
      // Sanitize modal content to prevent prompt injection
      const safeTitle = escapeHighlightsContent(modal.title);
      const safeSubtitle = escapeHighlightsContent(modal.subtitle);
      const safeDescription = escapeHighlightsContent(modal.description);
      return `
### Modal ${index + 1} (${date})
**Title:** ${safeTitle}
**Subtitle:** ${safeSubtitle}
**Description:**
${safeDescription}
`.trim();
    })
    .join('\n\n---\n\n');
}

/**
 * Build the prompt for generating weekly highlights from What's New modals
 * @param modals - Array of modals to summarize
 * @param dateRange - Start and end dates for the highlights period
 * @param customTemplate - Optional custom prompt template (uses default if not provided)
 */
export function buildHighlightsPrompt(
  modals: ModalForHighlights[],
  dateRange: { start: string; end: string },
  customTemplate?: string
): string {
  const template = customTemplate || DEFAULT_HIGHLIGHTS_TEMPLATE;
  const formattedModals = formatModalsForPrompt(modals);

  return template
    .replace(/\{\{dateRangeStart\}\}/g, dateRange.start)
    .replace(/\{\{dateRangeEnd\}\}/g, dateRange.end)
    .replace(/\{\{modalCount\}\}/g, String(modals.length))
    .replace(/\{\{modalsFormatted\}\}/g, formattedModals)
    .replace(/\{\{exampleFormat\}\}/g, EXAMPLE_HIGHLIGHTS_FORMAT)
    .trim();
}

/**
 * Format highlights for Slack (convert markdown to Slack mrkdwn)
 */
export function formatHighlightsForSlack(highlights: string): string {
  return (
    highlights
      // Convert markdown headers to Slack bold
      .replace(/^### (.+)$/gm, '*$1*')
      .replace(/^## (.+)$/gm, '\n*$1*\n')
      .replace(/^# (.+)$/gm, '\n*$1*\n')
      // Convert markdown bold to Slack bold
      .replace(/\*\*(.+?)\*\*/g, '*$1*')
      // Convert markdown links to Slack links
      .replace(/\[(.+?)\]\((.+?)\)/g, '<$2|$1>')
      // Clean up excessive newlines
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/**
 * Create Slack Block Kit blocks for rich formatting
 */
export function createSlackBlocks(
  highlights: string,
  dateRange: { start: string; end: string }
): Array<Record<string, unknown>> {
  const formattedHighlights = formatHighlightsForSlack(highlights);

  // Split into sections (by double newlines)
  const sections = formattedHighlights.split('\n\n').filter(s => s.trim());

  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `Weekly Highlights - ${dateRange.start} to ${dateRange.end}`,
        emoji: true,
      },
    },
    {
      type: 'divider',
    },
  ];

  // Add each section as a text block (Slack limits section text to 3000 chars)
  for (const section of sections) {
    if (section.length <= 3000) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: section,
        },
      });
    } else {
      // Split long sections
      const chunks = section.match(/.{1,2900}/gs) || [];
      for (const chunk of chunks) {
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: chunk,
          },
        });
      }
    }
  }

  // Add footer with divider
  blocks.push(
    {
      type: 'divider',
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `_Auto-generated from What's New announcements | ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })}_`,
        },
      ],
    }
  );

  return blocks;
}

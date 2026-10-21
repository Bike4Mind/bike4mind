import { z } from 'zod';
import { WHATS_NEW_VALIDATION_LIMITS } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';

// Sanitization limits derived from shared constants (using defaults). Intentionally
// static for security - sanitization is a safety net and must not be runtime-configurable.
const SANITIZATION_LIMITS = {
  MAX_RELEASE_BODY_LENGTH: WHATS_NEW_VALIDATION_LIMITS.maxReleaseBodyLength.default,
  MAX_COMMITS: WHATS_NEW_VALIDATION_LIMITS.maxCommits.default,
  MAX_COMMIT_MESSAGE_LENGTH: WHATS_NEW_VALIDATION_LIMITS.maxCommitMessageLength.default,
  MAX_PRS: WHATS_NEW_VALIDATION_LIMITS.maxPullRequests.default,
  MAX_PR_TITLE_LENGTH: WHATS_NEW_VALIDATION_LIMITS.maxPRTitleLength.default,
  MAX_PR_BODY_LENGTH: WHATS_NEW_VALIDATION_LIMITS.maxPRBodyLength.default,
  MAX_CHANGELOG_LENGTH: WHATS_NEW_VALIDATION_LIMITS.maxChangelogLength.default,
} as const;

export interface ReleaseContent {
  releaseBody: string;
  commits: Array<{ message: string }>;
  pullRequests: Array<{
    title: string;
    body: string | null;
  }>;
  changelogExcerpt?: string;
}

export interface SanitizedContent {
  releaseBody: string;
  commits: Array<{ message: string }>;
  pullRequests: Array<{
    title: string;
    body: string;
  }>;
  changelogExcerpt: string;
}

export interface PromptParams {
  styleExamples: Array<{
    title?: string | null;
    subtitle?: string | null;
    description?: string | null;
  }>;
  releaseData: SanitizedContent;
  // NEW: Support for daily batching
  releaseTag?: string; // Optional for backward compatibility
  changelogData?: {
    title: string;
    briefSummary: string[];
    sections: any[];
  };
  releases?: Array<{
    tag: string;
    name: string;
    publishedAt: string;
    body?: string;
  }>;
  generatedDate?: string; // YYYY-MM-DD format
}

// Validates LLM output; uses shared constants for default max lengths (single source of truth).
//
// The min values here (5, 10, 50) are intentionally different from the config limits in
// WHATS_NEW_VALIDATION_LIMITS (10, 10, 50): config limits bound what admins can configure as
// the max length, while these hardcoded mins validate actual LLM output, allowing shorter text
// that still clears a quality bar. Example: admin sets titleMaxLength=100 (config range 10-200);
// the LLM can then produce a title of 5-100 chars.
const L = WHATS_NEW_VALIDATION_LIMITS;

export const WhatsNewModalSchema = z.object({
  title: z.string().min(5).max(L.titleMaxLength.default),
  subtitle: z.string().min(10).max(L.subtitleMaxLength.default),
  description: z.string().min(50).max(L.descriptionMaxLength.default),
});

export type WhatsNewModalData = z.infer<typeof WhatsNewModalSchema>;

/**
 * Create a Zod schema for validating LLM output with custom limits from config.
 * Use this when you have access to admin config for dynamic validation.
 *
 * @param limits - Custom max lengths from admin config. Falls back to defaults if not provided.
 */
export function createWhatsNewModalSchema(limits: {
  titleMaxLength?: number;
  subtitleMaxLength?: number;
  descriptionMaxLength?: number;
}) {
  return z.object({
    title: z
      .string()
      .min(5)
      .max(limits.titleMaxLength ?? L.titleMaxLength.default),
    subtitle: z
      .string()
      .min(10)
      .max(limits.subtitleMaxLength ?? L.subtitleMaxLength.default),
    description: z
      .string()
      .min(50)
      .max(limits.descriptionMaxLength ?? L.descriptionMaxLength.default),
  });
}

/**
 * Truncate text to a maximum length
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

/**
 * Strip HTML tags from text
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '') // Remove HTML tags
    .replace(/&nbsp;/g, ' ') // Replace &nbsp; with space
    .replace(/&amp;/g, '&') // Replace &amp; with &
    .replace(/&lt;/g, '<') // Replace &lt; with <
    .replace(/&gt;/g, '>') // Replace &gt; with >
    .replace(/&quot;/g, '"') // Replace &quot; with "
    .trim();
}

/**
 * Escape potential prompt injection patterns
 *
 * Filters common LLM injection patterns from user-controlled content
 * to prevent malicious prompts in commit messages, PR descriptions, etc.
 */
export function escapePromptInjection(text: string): string {
  return (
    text
      // Remove common injection command patterns (case-insensitive)
      .replace(/IGNORE\s+(ALL\s+)?PREVIOUS\s+INSTRUCTIONS/gi, '[filtered]')
      .replace(/YOU\s+ARE\s+NOW/gi, '[filtered]')
      .replace(/SYSTEM\s*:/gi, '[filtered]')
      .replace(/\[SYSTEM\]/gi, '[filtered]')
      .replace(/OUTPUT\s*:/gi, '[filtered]')
      // Escape characters that could break JSON structure
      .replace(/[{}[\]]/g, match => `\\${match}`)
      .trim()
  );
}

/**
 * Sanitize content to prevent prompt injection and reduce size
 */
export function sanitizeContentForLLM(content: ReleaseContent): SanitizedContent {
  return {
    releaseBody: escapePromptInjection(
      truncateText(stripHtml(content.releaseBody), SANITIZATION_LIMITS.MAX_RELEASE_BODY_LENGTH)
    ),
    commits: content.commits.slice(0, SANITIZATION_LIMITS.MAX_COMMITS).map(c => ({
      message: escapePromptInjection(
        truncateText(c.message.split('\n')[0], SANITIZATION_LIMITS.MAX_COMMIT_MESSAGE_LENGTH)
      ),
    })),
    pullRequests: content.pullRequests.slice(0, SANITIZATION_LIMITS.MAX_PRS).map(pr => ({
      title: escapePromptInjection(truncateText(pr.title, SANITIZATION_LIMITS.MAX_PR_TITLE_LENGTH)),
      body: escapePromptInjection(truncateText(stripHtml(pr.body || ''), SANITIZATION_LIMITS.MAX_PR_BODY_LENGTH)),
    })),
    changelogExcerpt: escapePromptInjection(
      truncateText(content.changelogExcerpt || '', SANITIZATION_LIMITS.MAX_CHANGELOG_LENGTH)
    ),
  };
}

/**
 * Build comprehensive prompt for LLM
 * @param params - Parameters containing release data and style examples
 * @param customTemplate - Optional custom Handlebars template string
 * @returns Formatted prompt string for LLM
 */
export function buildWhatsNewPrompt(params: PromptParams, customTemplate?: string, logger?: Logger): string {
  // Format style examples
  const styleExamplesText =
    params.styleExamples.length > 0
      ? params.styleExamples
          .map(
            m => `
Title: ${m.title || 'N/A'}
Subtitle: ${m.subtitle || 'N/A'}
Description: ${m.description || 'N/A'}
---`
          )
          .join('\n')
      : "No previous examples available. Create an engaging What's New modal in a professional yet exciting tone.";

  // If custom template provided, use template rendering
  if (customTemplate) {
    try {
      // Import renderTemplate dynamically to avoid circular dependencies
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { renderTemplate } = require('./whatsNewGeneration.templateUtils');

      // Format data for template variables
      const templateData = {
        styleExamples: styleExamplesText,
        releaseTag: params.releaseTag || (params.releases && params.releases[0]?.tag) || 'N/A',
        releaseBody: params.releaseData.releaseBody,
        pullRequests: params.releaseData.pullRequests.map(pr => `- ${pr.title}: ${pr.body}`).join('\n'),
        commits: params.releaseData.commits.map(c => `- ${c.message}`).join('\n'),
        changelogExcerpt: params.releaseData.changelogExcerpt || 'Not available',
        // NEW: Changelog context for daily batching
        changelogData: params.changelogData
          ? `
Title: ${params.changelogData.title}

Summary:
${params.changelogData.briefSummary.map(s => `- ${s}`).join('\n')}

Sections:
${JSON.stringify(params.changelogData.sections, null, 2)}`
          : 'Not available',
        releases: params.releases
          ? params.releases.map(r => `- ${r.tag} (${r.name}) - ${r.publishedAt}`).join('\n')
          : params.releaseTag || 'N/A',
        generatedDate: params.generatedDate || 'N/A',
      };

      return renderTemplate(customTemplate, templateData);
    } catch (error) {
      // Fall through to default template if rendering fails
      const templateLogger =
        logger ?? new Logger({ metadata: { handler: 'whatsNewGeneration', phase: 'template-render' } });
      templateLogger.error('Error rendering custom template, falling back to default', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Format release information based on mode (PR-based vs release-based)
  const isPRMode = !params.releases || params.releases.length === 0;
  const releaseInfoSection = isPRMode
    ? `Generated Date: ${params.generatedDate || 'N/A'}

Mode: Pull Request Batch (daily update batching multiple PRs and commits)
NOTE: This is a PR-based update. Use the generated date for the title, NOT version numbers.
Title Format: "What's New - [Month Day, Year]" (e.g., "What's New - November 21, 2025")`
    : params.releases && params.releases.length > 0
      ? `Generated Date: ${params.generatedDate || 'N/A'}

Releases in this batch:
${params.releases.map(r => `- ${r.tag} (${r.name}) published at ${r.publishedAt}`).join('\n')}`
      : `Version: ${params.releaseTag || 'N/A'}`;

  // Format changelog context if available
  const changelogSection = params.changelogData
    ? `

AI-GENERATED CHANGELOG (use this as context for understanding the changes):
Title: ${params.changelogData.title}

Brief Summary:
${params.changelogData.briefSummary.map(s => `- ${s}`).join('\n')}

Detailed Sections:
${params.changelogData.sections
  .map(section => {
    if (section.type === 'features') {
      return `Features:\n${section.items.map((item: string) => `  - ${item}`).join('\n')}`;
    } else if (section.type === 'fixes') {
      return `Bug Fixes:\n${section.items.map((item: string) => `  - ${item}`).join('\n')}`;
    } else if (section.type === 'improvements') {
      return `Improvements:\n${section.items.map((item: string) => `  - ${item}`).join('\n')}`;
    }
    return '';
  })
  .join('\n\n')}

NOTE: The changelog above is technical and developer-focused. Your task is to ADAPT this into user-friendly language that emphasizes benefits and outcomes rather than implementation details.`
    : '';

  // Production prompt template - matches the proven template used for months
  return `You are generating a "What's New" modal for an AI-powered productivity and chat platform.

<style_reference>
STYLE EXAMPLES (for FORMAT and TONE only - DO NOT copy features from these):
${styleExamplesText}

CRITICAL: The style examples above show formatting style ONLY. DO NOT mention any features from the style examples. Your ONLY source of truth for features is the Pull Requests and Commits sections below.
</style_reference>

<release_data>
RELEASE INFORMATION:
${releaseInfoSection}

Release Notes:
${params.releaseData.releaseBody}

Pull Requests:
${params.releaseData.pullRequests.map(pr => `- ${pr.title}: ${pr.body}`).join('\n')}

Commits:
${params.releaseData.commits.map(c => `- ${c.message}`).join('\n')}

Changelog:
${params.releaseData.changelogExcerpt || 'Not available'}${changelogSection}
</release_data>

<classification_rules>
SCOPE INTERPRETATION - What IS user-facing (INCLUDE these):

- feat(mcp): = AGENT CAPABILITIES - Users interact with AI agents that use these tools. Frame as "Your AI assistant can now [capability]" or "Agents now support [action]"
- feat(tools): = TOOL IMPROVEMENTS - Performance or capability changes users experience through AI
- Integrations (slack, github, jira, atlassian, confluence) = Third-party connections users benefit from
- feat(kb-search): or search improvements = Knowledge base features users query
- feat(questmaster): = QuestMaster AI agent improvements users interact with
- feat(voice): = Voice interaction features
- feat(client): = UI/UX changes users see in the web app
- feat(settings): = User settings pages (NOT admin panel)
- feat(api): = API features that affect end-user experience (rate limits, new capabilities)
- feat(auth): = Authentication improvements (SSO, login experience)
- feat(cli): = CLI features - the b4m CLI is installed by users and tied to their accounts
- New AI models or model improvements
- Performance improvements users can feel (faster search, faster responses)

SCOPE INTERPRETATION - What is NOT user-facing (EXCLUDE these):

- Admin panel changes (/admin routes, admin dashboard, admin settings UI)
- Security operations dashboard (secops, security-dashboard)
- Dependency updates (npm, chore(deps), version bumps)
- Typo fixes and formatting changes
- CI/CD and workflow changes (GitHub Actions, build pipelines)
- Internal refactoring with no user-facing impact
- Database migrations and schema changes
- Build system changes (webpack, vite, bundler config)
- Test file changes
- Developer documentation (docs that aren't user guides)
- "What's New" modal configuration changes (meta - about this system itself)

CLASSIFICATION EXAMPLES:

GOOD (announce these):
- "feat(mcp): add create_branch tool" → "Your AI assistant can now create GitHub branches directly"
- "feat(slack): add thread support" → "Slack integration now supports threaded conversations"
- "feat(kb-search): improve relevance" → "Find what you need faster with improved search results"
- "fix(client): modal not closing" → Mention as bug fix if significant

BAD (do NOT announce these):
- "chore(deps): bump lodash" → Dependency update, skip
- "fix(admin): validation error" → Admin-only, skip
- "refactor(server): optimize queries" → Internal, skip unless users feel the performance difference
- "docs: update README" → Developer docs, skip
</classification_rules>

<format_instructions>
INSTRUCTIONS:
1. Title: Short, catchy (5-10 words), use format "What's New - [Month Day, Year]" with today's date
2. Subtitle: Key benefit highlight (10-20 words), enthusiastic but professional
3. Description: Use ADAPTIVE format based on number of user-facing changes:

ADAPTIVE FORMAT RULES:
- For SMALL updates (1-2 features): Use condensed format
- For LARGER updates (3+ features): Use full detailed format

CONDENSED FORMAT (small updates):
## **[Catchy Header]**

Brief summary paragraph.

### What's New
- **Feature Name** - Brief description of benefit

---
**TL;DR**: One-line summary

FULL DETAILED FORMAT (larger updates):
## **[Catchy Header]**

Summary paragraph highlighting key improvements.

### What's New
- **Feature Name** - User-focused benefit description
[repeat for each feature]

### How to Use These Improvements

#### Feature Name
- **What's new**: Key capabilities
- **How it works**: Brief explanation
- **What you experience**:
  - **Before:** Description of old behavior
  - **After:** Description of new behavior
- **What you get**: Benefits list
[repeat for major features]

### Automatic Improvements
List of automatic improvements that require no user action.

### What This Unlocks
- **For [User Type]:** Benefits description
[use bullet points for each user type]

---
**TL;DR**:
- **Feature**: One-line summary
[repeat for each feature]
</format_instructions>

<content_guidelines>
CONTENT GUIDELINES:
- ONLY describe features found in the Pull Requests and Commits above - DO NOT invent or hallucinate features
- DO NOT copy features from style examples - they are old announcements for different releases
- Focus on USER BENEFITS, not technical details
- For MCP features: Frame as "Your AI assistant can now..." or "Agents now support..."
- For integrations: Frame as improved connectivity or workflow automation
- Use at most 1-2 emojis in the entire modal, only if they add significant value
- Keep description under 10,000 characters
- If there are very few user-facing changes, keep the modal brief - do not pad with invented features
</content_guidelines>

<special_case>
IMPORTANT: If after applying the classification rules there are ZERO user-facing features to announce, return EXACTLY this JSON (do not generate an "Under the Hood" message):
{"title": "NO_USER_FACING_CHANGES", "subtitle": "", "description": ""}

This signals that no modal should be shown to users.
</special_case>

<output_format>
OUTPUT FORMAT (strict JSON):
{"title": "...", "subtitle": "...", "description": "..."}

CRITICAL JSON REQUIREMENTS:
- Return ONLY the JSON object above, no markdown code blocks, no extra text
- All newlines in strings MUST be escaped as \\n (backslash + letter n)
- All double quotes inside strings MUST be escaped as \\"
- Do NOT use actual line breaks inside JSON string values
- Example: "description": "## Header\\n\\nParagraph text.\\n\\n### Section\\n- Item"
</output_format>`;
}

/**
 * Extract JSON from LLM response (handles markdown code blocks)
 */
export function extractJsonFromResponse(text: string): string {
  // Try to match JSON in code block
  const jsonMatch =
    text.match(/```json\n([\s\S]*?)\n```/) || text.match(/```\n([\s\S]*?)\n```/) || text.match(/\{[\s\S]*\}/);

  if (jsonMatch) {
    return jsonMatch[1] || jsonMatch[0];
  }

  return text;
}

/**
 * List of allowed template variables that can be used in custom prompt templates
 */
export const ALLOWED_TEMPLATE_VARIABLES = [
  'styleExamples',
  'releaseTag',
  'releaseBody',
  'pullRequests',
  'commits',
  'changelogExcerpt',
] as const;

export const TEMPLATE_VARIABLE_DOCS = {
  styleExamples: 'Previous modal examples formatted as title/subtitle/description blocks',
  releaseTag: 'Version number/tag of the release (e.g., "v1.2.3")',
  releaseBody: 'Main release notes text from GitHub',
  pullRequests: 'List of merged pull requests with titles and descriptions',
  commits: 'List of commit messages included in this release',
  changelogExcerpt: 'Relevant section from the CHANGELOG.md file',
};

/**
 * Common prompt injection patterns to detect
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
  // Find all {{variable}} patterns
  const variablePattern = /\{\{(\w+)\}\}/g;
  const matches = Array.from(template.matchAll(variablePattern));
  const invalidVars: string[] = [];

  for (const match of matches) {
    const varName = match[1];
    if (!ALLOWED_TEMPLATE_VARIABLES.includes(varName as any)) {
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
 * Validates that template contains required JSON output format instruction
 * @param template - The template string to validate
 * @returns true if template appears to have output format guidance
 */
export function hasOutputFormatInstruction(template: string): boolean {
  // Check for JSON-related keywords that indicate output format guidance
  const hasJsonKeyword = /\b(JSON|json)\b/.test(template);
  const hasFormatKeyword = /\b(format|output|return|response)\b/i.test(template);

  return hasJsonKeyword && hasFormatKeyword;
}

/**
 * Validates a custom template before saving
 * @param template - The template to validate
 * @returns Object with isValid flag and error messages
 */
export function validateTemplate(template: string): {
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

  // Check for output format instruction
  if (!hasOutputFormatInstruction(template)) {
    errors.push('Template should include instructions for JSON output format');
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Gets the default prompt template as a string for admin UI reference.
 * This should match the actual template built in whatsNewGeneration.utils.ts buildWhatsNewPrompt().
 */
export function getDefaultTemplateString(): string {
  return `You are generating a "What's New" modal for an AI-powered productivity and chat platform.

<style_reference>
STYLE EXAMPLES (for FORMAT and TONE only - DO NOT copy features from these):
{{styleExamples}}

CRITICAL: The style examples above show formatting style ONLY. DO NOT mention any features from the style examples. Your ONLY source of truth for features is the Pull Requests and Commits sections below.
</style_reference>

<release_data>
RELEASE INFORMATION:
{{releaseTag}}

Release Notes:
{{releaseBody}}

Pull Requests:
{{pullRequests}}

Commits:
{{commits}}

Changelog:
{{changelogExcerpt}}
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

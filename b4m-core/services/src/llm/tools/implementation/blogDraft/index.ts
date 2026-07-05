import { Logger } from '@bike4mind/observability';
import { randomUUID } from 'crypto';
import { ChatModels, ClaudeArtifactMimeTypes } from '@bike4mind/common';
import { ToolDefinition } from '../../base/types';
import { sanitizeJsonString } from '../../utils/jsonSanitize';

interface ContentTransformParams {
  sourceContent: string;
  voiceGuide?: string; // Voice/style guide content (markdown text)
  outputFormat: 'blog' | 'linkedin' | 'twitter' | 'newsletter';
  additionalInstructions?: string;
}

interface TransformResult {
  title: string;
  content: string;
  summary: string;
  suggestedTags: string[];
}

/**
 * Build system prompt for content transformation
 */
function buildTransformationPrompt(options: {
  voiceGuide?: string;
  outputFormat: 'blog' | 'linkedin' | 'twitter' | 'newsletter';
  additionalInstructions?: string;
}): string {
  const { voiceGuide, outputFormat, additionalInstructions } = options;

  let prompt = '';

  // Voice guide
  if (voiceGuide) {
    prompt += `# Voice & Style Guidelines\n\nYou must follow these writing style guidelines:\n\n${voiceGuide}\n\n---\n\n`;
  }

  // Output format instructions
  prompt += `# Output Format: ${outputFormat.toUpperCase()}\n\n`;

  switch (outputFormat) {
    case 'blog':
      prompt += `Transform the content into a well-structured blog post in markdown format.

Requirements:
- Clear, compelling title
- Well-structured sections with descriptive headings (##, ###)
- Markdown formatting (bold, italics, lists, code blocks where appropriate)
- Professional blog tone
- 800-2000 words (adjust based on source material depth)
- Include a brief summary/excerpt (2-3 sentences)
- Suggest 3-5 relevant tags

Structure:
1. Title (compelling, SEO-friendly)
2. Opening hook (grab attention in first paragraph)
3. Main content (clear sections with headings)
4. Conclusion or call to action

`;
      break;

    case 'linkedin':
      prompt += `[COMING SOON] Transform to LinkedIn post format.\n\n`;
      break;

    case 'twitter':
      prompt += `[COMING SOON] Transform to Twitter thread format.\n\n`;
      break;

    case 'newsletter':
      prompt += `[COMING SOON] Transform to newsletter format.\n\n`;
      break;
  }

  // Additional instructions
  if (additionalInstructions) {
    prompt += `# Additional Instructions\n\n${additionalInstructions}\n\n`;
  }

  // Output format
  prompt += `---

# Output Format

Respond with a JSON object in this exact format:

\`\`\`json
{
  "title": "The blog post title",
  "content": "Full markdown content here...",
  "summary": "2-3 sentence summary/excerpt",
  "suggestedTags": ["tag1", "tag2", "tag3"]
}
\`\`\`

IMPORTANT:
- The content field must be valid markdown
- Use proper markdown formatting (headings, lists, emphasis, code blocks)
- Do NOT include the title in the content (it's a separate field)
- The summary should be a compelling excerpt suitable for meta descriptions
- Suggest 3-5 relevant, specific tags (lowercase, hyphen-separated)
`;

  return prompt;
}

/**
 * Tolerantly strip markdown code fences when the paired-fence regex can't match
 * (closing fence attached without a preceding newline, or missing entirely).
 * Strips a leading ```/```json opener and a trailing ``` closer independently so
 * the embedded JSON object can be parsed instead of throwing on a stray backtick.
 */
function stripCodeFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```[a-zA-Z]*[ \t]*\r?\n?/, '') // leading ``` / ```json opener
    .replace(/\r?\n?[ \t]*```$/, '') // trailing closer
    .trim();
}

/**
 * Parse transformation result from LLM response
 */
function parseTransformationResult(llmResponse: string): TransformResult {
  // Handle empty or whitespace-only responses
  if (!llmResponse || !llmResponse.trim()) {
    throw new Error(
      'LLM returned an empty response. This may be due to content filtering, rate limiting, or a timeout. Please try again.'
    );
  }

  // Try to extract JSON from the response. The paired-fence regex handles the
  // common case (a ```json ... ``` block, possibly surrounded by prose), but it
  // requires the closing fence to be preceded by a newline. Models sometimes
  // attach the closing fence directly to the JSON, or omit it entirely on long
  // responses - in those cases the paired regex fails and the raw "```json..."
  // string would reach JSON.parse. Fall back to stripping a leading opener
  // fence and a trailing closer fence independently.
  const jsonMatch = llmResponse.match(/```json\s*\n([\s\S]*?)\n```/) || llmResponse.match(/```\s*\n([\s\S]*?)\n```/);

  let jsonStr = jsonMatch ? jsonMatch[1] : stripCodeFences(llmResponse);
  jsonStr = jsonStr.trim();

  // Check if extracted JSON is empty
  if (!jsonStr) {
    throw new Error(
      'Could not extract valid JSON from LLM response. The response may have been truncated or malformed.'
    );
  }

  // Sanitize JSON to handle unescaped control characters in string values
  jsonStr = sanitizeJsonString(jsonStr);

  try {
    const result = JSON.parse(jsonStr);

    if (!result.title || !result.content) {
      throw new Error('Missing required fields: title and content');
    }

    return {
      title: result.title,
      content: result.content,
      summary: result.summary || '',
      suggestedTags: result.suggestedTags || [],
    };
  } catch (error) {
    // Pass the error as its own arg so the logger's error-aware formatting keeps the stack/message
    // (JSON.stringify(new Error) -> {} would otherwise drop it); keep the large response as metadata.
    Logger.globalInstance.error('Failed to parse transformation result:', error, { response: llmResponse });
    throw new Error('Failed to parse transformation result from LLM');
  }
}

/**
 * Sanitize a title for safe, display-clean embedding in the <artifact title="...">
 * attribute. The pristine title lives in the JSON body (which is what the preview
 * card renders); this attribute is only used as a label/list value and for id
 * resolution. So we strip the parse-breaking characters rather than HTML-entity-
 * encode them - entity encoding renders as "&amp;"/"&lt;" gibberish wherever
 * `metadata.title` is shown verbatim (knowledge viewer list, etc.).
 *
 * - newlines/tabs -> space: the attribute regexes use `.*?`, which won't cross newlines.
 * - strip <,>: keep the tag/attribute matchers ([^>]) from breaking.
 * - straight quotes -> typographic quotes: the value matcher is [^"'], so BOTH a "
 *   and a ' (e.g. the apostrophe in "Can't") would terminate it early and truncate
 *   the title. Typographic (curly) quotes aren't in that class, so they're parse-safe
 *   and still read naturally.
 * `&` is left as-is: it doesn't break the regexes and React renders it correctly.
 */
function sanitizeArtifactTitle(title: string): string {
  return title
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/'/g, '’') // straight apostrophe to right single quote
    .replace(/"/g, '”') // straight double quote to right double quote
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Wrap a drafted blog result in an <artifact> tag so it is surfaced as a
 * first-class artifact (streamed into the reply AND persisted via the
 * sharedToolBuilder tool_result extractor).
 *
 * Two embedding concerns are handled here:
 * - Title goes in a tag attribute -> sanitized via sanitizeArtifactTitle (parse-safe,
 *   display-clean; the real title is preserved untouched in the JSON body).
 * - Blog prose can legitimately contain the literal "</artifact>" sequence, which
 *   would truncate the non-greedy artifact-body regex. We escape it as "<\/artifact>";
 *   JSON.parse treats "\/" as "/" and restores the original losslessly on the client.
 */
function wrapDraftAsArtifact(result: TransformResult, identifier: string): string {
  const artifactTitle = sanitizeArtifactTitle(result.title);
  const artifactBody = JSON.stringify(result, null, 2).replace(/<\/artifact>/gi, '<\\/artifact>');

  return `✨ Blog draft created successfully!

<artifact identifier="${identifier}" type="${ClaudeArtifactMimeTypes.BLOG_DRAFT}" title="${artifactTitle}">
${artifactBody}
</artifact>

📋 The preview card above is ready for you to review and edit before publishing.
`;
}

// Export for testing
export { sanitizeJsonString, parseTransformationResult, wrapDraftAsArtifact, sanitizeArtifactTitle };

export const blogDraftTool: ToolDefinition = {
  name: 'blog_draft',
  implementation: context => ({
    toolFn: async value => {
      const params = value as ContentTransformParams;
      const { logger, llm } = context;

      // Default outputFormat to 'blog' if not provided (LLMs sometimes omit required params)
      const outputFormat = params.outputFormat || 'blog';

      logger.info('Drafting blog content', {
        userId: context.userId,
        outputFormat,
        hasVoiceGuide: !!params.voiceGuide,
        hasAdditionalInstructions: !!params.additionalInstructions,
      });

      try {
        // 1. Build system prompt
        const systemPrompt = buildTransformationPrompt({
          voiceGuide: params.voiceGuide,
          outputFormat,
          additionalInstructions: params.additionalInstructions,
        });

        // 2. Call LLM with user's selected model (fallback to Claude 4.6 Sonnet)
        const modelToUse = context.model || ChatModels.CLAUDE_4_6_SONNET;
        logger.info('Using model for blog draft:', { model: modelToUse });

        let llmResponse = '';
        await llm.complete(
          modelToUse,
          [
            { role: 'system', content: systemPrompt },
            {
              role: 'user',
              content: `Transform this content:\n\n${params.sourceContent}`,
            },
          ],
          {
            temperature: 0.7,
            stream: false,
          },
          async texts => {
            llmResponse = texts.filter(t => t !== null && t !== undefined).join('');
          }
        );

        logger.info('Blog draft complete', { responseLength: llmResponse.length });

        // 4. Parse result
        const result = parseTransformationResult(llmResponse);

        logger.info('Blog draft created successfully', {
          title: result.title,
          contentLength: result.content.length,
          tagsCount: result.suggestedTags.length,
        });

        // 5. Return the draft wrapped in an <artifact> tag so it is surfaced as a
        // first-class artifact (see wrapDraftAsArtifact). UUID identifier so two
        // drafts created in the same millisecond can't collide.
        return wrapDraftAsArtifact(result, `blog-draft-${randomUUID()}`);
      } catch (error) {
        logger.error('Blog draft creation failed:', error);
        throw error;
      }
    },
    toolSchema: {
      name: 'blog_draft',
      description:
        '🎯 PRIMARY TOOL FOR BLOGGING: Use this tool when user wants to publish conversation/content to their blog. Transforms raw content into structured blog post format. ALWAYS use this for phrases like "publish to my blog", "blog this conversation", "create a blog post". Returns JSON that frontend automatically renders as preview card. This is the FIRST STEP - user will review/edit before final publish. DO NOT skip this step.',
      parameters: {
        type: 'object',
        properties: {
          sourceContent: {
            type: 'string',
            description:
              'The content to transform into a blog draft. This can be conversation history, article text, notes, etc. Include all relevant context.',
          },
          voiceGuide: {
            type: 'string',
            description:
              'Optional voice/style guide content (markdown text) to apply. This should contain writing style instructions and patterns.',
          },
          outputFormat: {
            type: 'string',
            enum: ['blog', 'linkedin', 'twitter', 'newsletter'],
            description: 'Output format to generate. Currently only "blog" is fully supported. Others are coming soon.',
          },
          additionalInstructions: {
            type: 'string',
            description:
              'Optional additional instructions for the draft. Examples: "Make it more technical", "Add code examples", "Focus on business impact"',
          },
        },
        required: ['sourceContent', 'outputFormat'],
      },
    },
  }),
};

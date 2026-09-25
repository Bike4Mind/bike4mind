import { useEffect, useRef, useState } from 'react';
import { useGetSessionQuests } from './data/sessions';

interface TransformedContent {
  title: string;
  content: string;
  summary: string;
  suggestedTags: string[];
}

/**
 * Hook to detect when blog_draft tool completes and extract the result
 */
export const useContentTransformDetector = (sessionId: string | null) => {
  const [transformedContent, setTransformedContent] = useState<TransformedContent | null>(null);
  const [shouldShowPreview, setShouldShowPreview] = useState(false);
  const lastProcessedQuestId = useRef<string | null>(null);

  const { data: questsData } = useGetSessionQuests(sessionId);

  useEffect(() => {
    if (!questsData?.pages || questsData.pages.length === 0) {
      return;
    }

    const firstPage = questsData.pages[0];
    if (!firstPage?.data || firstPage.data.length === 0) {
      return;
    }

    const latestQuest = firstPage.data[0]; // Assuming sorted by createdAt desc

    if (lastProcessedQuestId.current === latestQuest.id) {
      return;
    }

    if (!latestQuest.reply || latestQuest.reply.trim() === '') {
      return;
    }

    const hasSuccessMessage = latestQuest.reply.includes('Blog draft created successfully');
    const hasJsonBlock = latestQuest.reply.includes('```json');

    if (!hasSuccessMessage || !hasJsonBlock) {
      return;
    }

    const parsed = parseContentTransformResponse(latestQuest.reply);
    if (parsed) {
      setTransformedContent(parsed);
      setShouldShowPreview(true);
      lastProcessedQuestId.current = latestQuest.id || null;
    }
  }, [questsData]);

  const clearPreview = () => {
    setShouldShowPreview(false);
    // Don't clear transformedContent - keep it in case user wants to reference it
  };

  return {
    transformedContent,
    shouldShowPreview,
    clearPreview,
  };
};

/**
 * Parse blog_draft tool response to extract structured data
 *
 * Expected format from tool:
 * ```
 * Blog draft created successfully!
 *
 * **Title:** The blog post title
 *
 * **Summary:** 2-3 sentence summary
 *
 * **Suggested Tags:** tag1, tag2, tag3
 *
 * **Content Preview (first 500 chars):**
 * Full markdown content here...
 * ```
 */
export function parseContentTransformResponse(response: string): TransformedContent | null {
  try {
    // Try to extract JSON from code blocks first (in case tool response format changes)
    const jsonBody = matchNewlineFence(response, 'json') ?? matchNewlineFence(response, '');

    if (jsonBody !== null) {
      const jsonStr = jsonBody.trim();
      const parsed = JSON.parse(jsonStr);
      return {
        title: parsed.title || '',
        content: parsed.content || '',
        summary: parsed.summary || '',
        suggestedTags: parsed.suggestedTags || [],
      };
    }

    // Fallback: Parse the formatted text response
    const title = matchLabelValue(response, '**Title:**');
    const summary = matchLabelValue(response, '**Summary:**');
    const tagsValue = matchLabelValue(response, '**Suggested Tags:**');

    // Extract content - everything after "Content Preview" or the full content section
    const preview = matchContentPreview(response);
    let contentMatch: string[] | null = preview === null ? null : ['', preview];

    // If no content preview found, try to find the actual full content from the tool's internal result
    // This is a bit hacky but works for the current tool implementation
    if (!contentMatch) {
      const afterMetadata = response.split('**Content Preview')[1] || response.split('**Next Steps')[0];
      if (afterMetadata) {
        contentMatch = ['', afterMetadata.replace(/^[^a-zA-Z#]*/, '').trim()];
      }
    }

    if (title === null || !contentMatch) {
      return null;
    }

    const tags =
      tagsValue !== null
        ? tagsValue
            .split(',')
            .map(tag => tag.trim())
            .filter(Boolean)
        : [];

    return {
      title: title.trim(),
      content: contentMatch[1].trim(),
      summary: summary !== null ? summary.trim() : '',
      suggestedTags: tags,
    };
  } catch (error) {
    return null;
  }
}

// These three helpers replace regexes that rescanned the rest of the input from every repeated
// opener or label; each returns what the old regex's first match captured, in linear time.
const WHITESPACE = /\s/;
const isLineTerminator = (c: string | undefined) => c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029';

/** Group 1 of /```LANG[^\S\n]*\n([\s\S]*?)\n```/, or null. */
export function matchNewlineFence(text: string, lang: string): string | null {
  const opener = '```' + lang;
  for (let at = text.indexOf(opener); at !== -1; at = text.indexOf(opener, at + 1)) {
    let i = at + opener.length;
    while (i < text.length && text[i] !== '\n' && WHITESPACE.test(text[i])) i++;
    if (text[i] !== '\n') continue;
    // A later opener's body starts later, so it cannot find a closer this one missed.
    const close = text.indexOf('\n```', i + 1);
    return close === -1 ? null : text.slice(i + 1, close);
  }
  return null;
}

/** Group 1 of new RegExp(escape(label) + '\\s*(.+?)(?:\\n|$)'), backtracking \s* included, or null. */
export function matchLabelValue(text: string, label: string): string | null {
  const n = text.length;
  // breakAt is the first line terminator (or n) at or after every index in [breakFrom, breakAt].
  let breakFrom = n + 1;
  let breakAt = n;
  for (let at = text.indexOf(label); at !== -1; at = text.indexOf(label, at + 1)) {
    const start = at + label.length;
    let i = start;
    while (i < n && WHITESPACE.test(text[i])) i++;
    if (i < breakFrom || i > breakAt) {
      breakFrom = i;
      breakAt = i;
      while (breakAt < n && !isLineTerminator(text[breakAt])) breakAt++;
    }
    // Try the value start from the longest whitespace run down, as the backtracking \s* does.
    for (let lineEnd = breakAt; i >= start; i--) {
      if (isLineTerminator(text[i])) lineEnd = i;
      if (i < n && !isLineTerminator(text[i]) && (lineEnd === n || text[lineEnd] === '\n')) {
        return text.slice(i, lineEnd);
      }
    }
  }
  return null;
}

/** Group 1 of /\*\*Content Preview[^:]*:\*\*[^\S\n]*\n([\s\S]+?)(?:\n---|\n\*\*Next Steps|\n$)/, or null. */
export function matchContentPreview(text: string): string | null {
  const opener = '**Content Preview';
  let colon = -1;
  let failedColon = -1;
  for (let at = text.indexOf(opener); at !== -1; at = text.indexOf(opener, at + 1)) {
    if (colon < at) colon = text.indexOf(':', at + opener.length);
    if (colon === -1) return null;
    if (colon === failedColon) continue;
    let i = colon + 3;
    while (i < text.length && text[i] !== '\n' && WHITESPACE.test(text[i])) i++;
    if (!text.startsWith(':**', colon) || text[i] !== '\n') {
      failedColon = colon;
      continue;
    }
    // A later opener's body starts no earlier, so it cannot find an end this one missed.
    for (let end = text.indexOf('\n', i + 2); end !== -1; end = text.indexOf('\n', end + 1)) {
      if (end === text.length - 1 || text.startsWith('\n---', end) || text.startsWith('\n**Next Steps', end)) {
        return text.slice(i + 1, end);
      }
    }
    return null;
  }
  return null;
}

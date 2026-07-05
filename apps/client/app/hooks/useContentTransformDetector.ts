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
function parseContentTransformResponse(response: string): TransformedContent | null {
  try {
    // Try to extract JSON from code blocks first (in case tool response format changes)
    const jsonMatch = response.match(/```json\s*\n([\s\S]*?)\n```/) || response.match(/```\s*\n([\s\S]*?)\n```/);

    if (jsonMatch) {
      const jsonStr = jsonMatch[1].trim();
      const parsed = JSON.parse(jsonStr);
      return {
        title: parsed.title || '',
        content: parsed.content || '',
        summary: parsed.summary || '',
        suggestedTags: parsed.suggestedTags || [],
      };
    }

    // Fallback: Parse the formatted text response
    const titleMatch = response.match(/\*\*Title:\*\*\s*(.+?)(?:\n|$)/);
    const summaryMatch = response.match(/\*\*Summary:\*\*\s*(.+?)(?:\n|$)/);
    const tagsMatch = response.match(/\*\*Suggested Tags:\*\*\s*(.+?)(?:\n|$)/);

    // Extract content - everything after "Content Preview" or the full content section
    let contentMatch = response.match(/\*\*Content Preview[^:]*:\*\*\s*\n([\s\S]+?)(?:\n---|\n\*\*Next Steps|\n$)/);

    // If no content preview found, try to find the actual full content from the tool's internal result
    // This is a bit hacky but works for the current tool implementation
    if (!contentMatch) {
      const afterMetadata = response.split('**Content Preview')[1] || response.split('**Next Steps')[0];
      if (afterMetadata) {
        contentMatch = ['', afterMetadata.replace(/^[^a-zA-Z#]*/, '').trim()];
      }
    }

    if (!titleMatch || !contentMatch) {
      return null;
    }

    const tags = tagsMatch
      ? tagsMatch[1]
          .split(',')
          .map(tag => tag.trim())
          .filter(Boolean)
      : [];

    return {
      title: titleMatch[1].trim(),
      content: contentMatch[1].trim(),
      summary: summaryMatch ? summaryMatch[1].trim() : '',
      suggestedTags: tags,
    };
  } catch (error) {
    return null;
  }
}

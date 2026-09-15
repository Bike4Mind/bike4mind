import { useCallback, useState } from 'react';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import type { IChatHistoryItemDocument } from '@bike4mind/common';
import { useSessions } from '@client/app/contexts/SessionsContext';
import { convertSessionToMarkdown } from '@client/app/utils/sessionMarkdownExport';

/**
 * Copy the current session's chat history to the clipboard as Markdown,
 * read from the react-query cache (no refetch). `copied` flips true for 2s
 * after a successful copy so callers can swap in a confirmation icon.
 */
export function useCopySessionMarkdown() {
  const [copied, setCopied] = useState(false);
  const { currentSessionId } = useSessions();
  const queryClient = useQueryClient();

  const copyMarkdown = useCallback(async () => {
    if (!currentSessionId) return;
    try {
      const queryData = queryClient.getQueryData<InfiniteData<{ data: IChatHistoryItemDocument[] }>>([
        'quests',
        'session',
        currentSessionId,
      ]);
      if (!queryData?.pages) return;

      const quests = queryData.pages.flatMap(p => p.data).reverse(); // chronological order
      const markdown = convertSessionToMarkdown(quests);

      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy markdown:', err);
    }
  }, [currentSessionId, queryClient]);

  return { copyMarkdown, copied };
}

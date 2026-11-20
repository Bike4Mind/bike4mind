import { useCallback, useState } from 'react';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import type { IChatHistoryItemDocument } from '@bike4mind/common';
import { useSessions } from '@client/app/contexts/SessionsContext';
import { convertSessionToMarkdown } from '@client/app/utils/sessionMarkdownExport';

/**
 * Supplies the Markdown for a chat that is not the main chat's current session (e.g. a
 * premium overlay's own chat). Return null, undefined or '' when there is nothing to copy.
 * Keep it fast and local (e.g. read from state you already hold): the clipboard write runs
 * after it resolves, and Safari rejects a write that lands after a slow await (such as a
 * network fetch) because the click's user activation has expired by then.
 */
export type GetCopyMarkdown = () => string | null | undefined | Promise<string | null | undefined>;

/**
 * Copy a chat to the clipboard as Markdown. By default that is the current session's
 * history, read from the react-query cache (no refetch); pass `getMarkdown` to copy a
 * different chat instead. `copied` flips true for 2s after a successful copy so callers
 * can swap in a confirmation icon.
 */
export function useCopySessionMarkdown(getMarkdown?: GetCopyMarkdown) {
  const [copied, setCopied] = useState(false);
  const { currentSessionId } = useSessions();
  const queryClient = useQueryClient();

  const copyMarkdown = useCallback(async () => {
    try {
      let markdown: string | null | undefined;
      if (getMarkdown) {
        markdown = await getMarkdown();
      } else {
        if (!currentSessionId) return;
        const queryData = queryClient.getQueryData<InfiniteData<{ data: IChatHistoryItemDocument[] }>>([
          'quests',
          'session',
          currentSessionId,
        ]);
        if (!queryData?.pages) return;
        const quests = queryData.pages.flatMap(p => p.data).reverse(); // chronological order
        markdown = convertSessionToMarkdown(quests);
      }
      if (!markdown) return;

      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy markdown:', err);
    }
  }, [getMarkdown, currentSessionId, queryClient]);

  return { copyMarkdown, copied };
}

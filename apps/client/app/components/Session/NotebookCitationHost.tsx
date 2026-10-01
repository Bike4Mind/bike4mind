import { FC, ReactNode, useCallback, useEffect, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { CitableSource } from '@bike4mind/common';
import { getFabFileByIdFromServer } from '@client/app/utils/filesAPICalls';
import { openFileInChatViewer } from '@client/app/hooks/useSessionLayout';
import { citedPassageOf } from '@client/app/components/Knowledge/citedPassage';
import { CitationInteractionProvider } from './CitationInteractionContext';

/**
 * True for the lake article chip the server builds (`...?article=<fileId>`), whose `id` is the file
 * id the host can fetch. Any other relative URL (e.g. a link to a notebook quest) is not a file and
 * keeps the default navigation.
 */
const isLakeArticleChip = (source: CitableSource): boolean => {
  if (!source.url) return false;
  try {
    return new URL(source.url, 'http://localhost').searchParams.get('article') === source.id;
  } catch {
    return false;
  }
};

/**
 * Keeps a lake citation inside the notebook: the chip opens its file in the chat's own
 * KnowledgeViewer, beside the conversation, instead of navigating to the article route and taking
 * the conversation off screen.
 *
 * Mirrors the data-lake View action (DataLakeExplorer.handleViewFile) through the shared
 * openFileInChatViewer: the file rides the transient `previewFile` slot, so opening it never
 * attaches it to the notebook.
 *
 * `sessionId` is the notebook on screen. This host stays mounted across notebook switches, so a
 * fetch that resolves after one must not open its file in the next notebook.
 */
const NotebookCitationHost: FC<{ sessionId?: string; children: ReactNode }> = ({ sessionId, children }) => {
  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);
  // Only the latest click may open: a slow fetch for an earlier chip must not replace a later one.
  const latestClickRef = useRef(0);

  const openInChat = useCallback(async (source: CitableSource) => {
    const click = ++latestClickRef.current;
    const clickedIn = sessionIdRef.current;
    const isCurrent = () => click === latestClickRef.current && clickedIn === sessionIdRef.current;
    try {
      const file = await getFabFileByIdFromServer(source.id);
      if (!isCurrent()) return;
      openFileInChatViewer(file, citedPassageOf(source));
    } catch (error) {
      if (isCurrent()) {
        console.error('Failed to open cited file in viewer:', error);
        toast.error(`Could not open "${source.title}"`);
      }
    }
  }, []);

  const onInternalCitationClick = useCallback(
    (source: CitableSource) => {
      if (!isLakeArticleChip(source)) return false;
      void openInChat(source);
      return true;
    },
    [openInChat]
  );

  const value = useMemo(() => ({ onInternalCitationClick }), [onInternalCitationClick]);

  return <CitationInteractionProvider value={value}>{children}</CitationInteractionProvider>;
};

export default NotebookCitationHost;

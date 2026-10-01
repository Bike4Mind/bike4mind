import { FC, ReactNode, useCallback, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { CitableSource } from '@bike4mind/common';
import { getFabFileByIdFromServer } from '@client/app/utils/filesAPICalls';
import { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import { citedPassageOf } from '@client/app/components/Knowledge/citedPassage';
import { CitationInteractionProvider } from './CitationInteractionContext';

/**
 * Keeps a lake citation inside the notebook: the chip opens its file in the chat's own
 * KnowledgeViewer, beside the conversation, instead of navigating to the article route and taking
 * the conversation off screen.
 *
 * Mirrors the data-lake View action (DataLakeExplorer.handleViewFile): the file rides the transient
 * `previewFile` slot, so opening it never attaches it to the notebook.
 */
const NotebookCitationHost: FC<{ children: ReactNode }> = ({ children }) => {
  // Only the latest click may open: a slow fetch for an earlier chip must not replace a later one.
  const latestClickRef = useRef(0);

  const openInChat = useCallback(async (source: CitableSource) => {
    const click = ++latestClickRef.current;
    try {
      const file = await getFabFileByIdFromServer(source.id);
      if (click !== latestClickRef.current) return;
      setSessionLayout({
        layout: 'vertical',
        previewFile: file,
        selectedArtifactId: file.id,
        citedPassage: citedPassageOf(source),
      });
    } catch {
      if (click === latestClickRef.current) toast.error(`Could not open "${source.title}"`);
    }
  }, []);

  const value = useMemo(() => ({ onInternalCitationClick: openInChat }), [openInChat]);

  return <CitationInteractionProvider value={value}>{children}</CitationInteractionProvider>;
};

export default NotebookCitationHost;

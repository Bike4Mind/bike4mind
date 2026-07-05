import { createContext, useContext, FC, ReactNode } from 'react';
import { CitableSource } from '@bike4mind/common';

/**
 * Generic, opt-in hook for hosts that want to handle citation-source clicks
 * themselves (e.g. open an in-surface document drawer) instead of CitableSources'
 * default behavior (navigate to the source's internal/external URL).
 *
 * Default is no handler -> CitableSources keeps its existing navigation behavior,
 * so this is invisible to every surface that doesn't provide it. Not specific to
 * any product; LibreOncology is simply the first consumer.
 */
interface CitationInteraction {
  /** If set, called instead of navigating when a citation source is clicked. */
  onCitationClick?: (source: CitableSource) => void;
}

const CitationInteractionContext = createContext<CitationInteraction>({});

export const CitationInteractionProvider: FC<{ value: CitationInteraction; children: ReactNode }> = ({
  value,
  children,
}) => <CitationInteractionContext.Provider value={value}>{children}</CitationInteractionContext.Provider>;

export const useCitationInteraction = (): CitationInteraction => useContext(CitationInteractionContext);

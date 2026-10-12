import type { MouseEvent } from 'react';
import type { CitableSource } from '@bike4mind/common';
import { useNavigate } from '@tanstack/react-router';
import { useCitationInteraction } from './CitationInteractionContext';
import { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import { citedPassageOf } from '@client/app/components/Knowledge/citedPassage';

export type CitableSourceClick = {
  /** A relative URL: an in-app deep link rather than an external page. */
  isInternal: boolean;
  /** True when the click is handled in-app, so the element must be a button, not an `<a>`. */
  renderAsButton: boolean;
  /** Undefined for an external source with no host override: its `<a target=_blank>` navigates. */
  onClick: ((event: MouseEvent) => void) | undefined;
};

/**
 * What clicking a cited source does, shared by the source chip and the inline `[N]` marker so the
 * two can never disagree about where a citation leads.
 */
export const useCitableSourceClick = (source: CitableSource): CitableSourceClick => {
  const navigate = useNavigate();
  // Opt-in host overrides: when a surface provides onCitationClick (any source) or
  // onInternalCitationClick (relative URLs only), the click is handled in-surface instead of
  // navigating. onCitationClick wins when both are set. Default (no provider) keeps the existing
  // navigation behavior.
  const { onCitationClick, onInternalCitationClick } = useCitationInteraction();

  const isInternal = !!source.url && source.url.startsWith('/');

  // Host override wins for any clickable source (internal or external) - lets a
  // surface present its own document view instead of navigating away.
  const handleHostClick = onCitationClick
    ? (event: MouseEvent) => {
        event.preventDefault();
        onCitationClick(source);
      }
    : undefined;

  const navigateToInternal = () => {
    // Hand the reader's destination the passage this citation cited, so the viewer can mark it
    // instead of dropping them at the top of the document (#3038). Written on EVERY internal
    // click, clearing on a source that carries no passage: a leftover anchor from the previous
    // citation would otherwise mark a stale extent in the newly-opened file.
    setSessionLayout({ citedPassage: citedPassageOf(source) });
    const url = new URL(source.url!, window.location.origin);
    navigate({ to: url.pathname as never, search: Object.fromEntries(url.searchParams) as never });
  };

  const handleInternalClick = () => {
    if (!onInternalCitationClick?.(source)) navigateToInternal();
  };

  return {
    isInternal,
    renderAsButton: isInternal || !!handleHostClick,
    onClick: handleHostClick ?? (isInternal ? handleInternalClick : undefined),
  };
};

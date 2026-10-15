import { samePrSummary, type PrSummary, type PrSummaryEvent } from '@shared/pullRequest';

/**
 * Fold PR summary pushes from main into the map the sidebar reads. Returns the map it was given
 * when nothing changed, so a push about some other state does not re-render the session list.
 */
export function applyPrSummaryEvents(
  current: ReadonlyMap<string, PrSummary>,
  events: readonly PrSummaryEvent[]
): ReadonlyMap<string, PrSummary> {
  let next: Map<string, PrSummary> | null = null;

  for (const event of events) {
    const soFar = next ?? current;
    if (samePrSummary(soFar.get(event.sessionId), event.summary)) continue;
    next ??= new Map(current);
    if (event.summary) next.set(event.sessionId, event.summary);
    else next.delete(event.sessionId);
  }

  return next ?? current;
}

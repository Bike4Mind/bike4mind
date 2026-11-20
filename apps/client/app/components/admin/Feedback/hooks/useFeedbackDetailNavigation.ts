import { useEffect, useState } from 'react';

interface UseFeedbackDetailNavigationParams {
  /** The current server page, already filtered and sorted. */
  rowIds: readonly string[];
  openId: string | undefined;
  /** 1-based. */
  page: number;
  pageSize: number;
  total: number;
  /** The list query has answered for the current page (not showing the previous page's rows). */
  settled: boolean;
  /** The list query for the current page failed. */
  failed: boolean;
  onPageChange: (page: number) => void;
  open: (id: string) => void;
}

export interface FeedbackDetailNavigation {
  /** 1-based place in the whole filtered list; undefined when the open report is not in it. */
  position?: { index: number; total: number };
  onPrevious?: () => void;
  onNext?: () => void;
}

/** A page turn waiting for its rows, from the report that was open when it started. */
type PendingEdge = { page: number; edge: 'first' | 'last'; fromId: string; fromPage: number };

/**
 * Previous/next for the feedback drawer, over the filtered and sorted list the table shows. The
 * list is paged server-side, so stepping past either end of the page turns the page and opens the
 * report at the matching edge once the new page has loaded.
 *
 * A status change can drop the open report out of the filtered list (closing one under the "New"
 * filter). Its last place is remembered, so next opens the report that moved up into that place
 * instead of leaving the reader with no way on.
 */
export const useFeedbackDetailNavigation = ({
  rowIds,
  openId,
  page,
  pageSize,
  total,
  settled,
  failed,
  onPageChange,
  open,
}: UseFeedbackDetailNavigationParams): FeedbackDetailNavigation => {
  const [pending, setPending] = useState<PendingEdge>();
  const [returnPage, setReturnPage] = useState<number>();
  const [lastPlace, setLastPlace] = useState<{ id: string; page: number; index: number }>();

  const index = openId ? rowIds.indexOf(openId) : -1;
  if (openId && index >= 0 && (lastPlace?.id !== openId || lastPlace.page !== page || lastPlace.index !== index)) {
    setLastPlace({ id: openId, page, index });
  }

  const pendingLanded = pending !== undefined && settled && page === pending.page;
  const pendingTargetId = pendingLanded
    ? pending.edge === 'first'
      ? rowIds[0]
      : rowIds[rowIds.length - 1]
    : undefined;
  // Done once the target is open, or when the page came back empty and there is nothing to open.
  if (pending && (openId !== pending.fromId || (pendingLanded && !pendingTargetId))) setPending(undefined);

  useEffect(() => {
    if (pendingTargetId) open(pendingTargetId);
  }, [pendingTargetId, open]);

  // A page turn that failed goes back to the page holding the open report, so previous/next work again.
  if (pending && openId === pending.fromId && failed && page === pending.page) {
    setPending(undefined);
    setReturnPage(pending.fromPage);
  }
  if (returnPage !== undefined && page === returnPage) setReturnPage(undefined);
  useEffect(() => {
    if (returnPage !== undefined) onPageChange(returnPage);
  }, [returnPage, onPageChange]);

  if (!openId || pending) return {};

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const fromId = openId;
  const turnPage = (target: number, edge: PendingEdge['edge']) => () => {
    setPending({ page: target, edge, fromId, fromPage: page });
    onPageChange(target);
  };

  if (index >= 0) {
    return {
      position: { index: (page - 1) * pageSize + index + 1, total },
      onPrevious: index > 0 ? () => open(rowIds[index - 1]) : page > 1 ? turnPage(page - 1, 'last') : undefined,
      onNext:
        index < rowIds.length - 1
          ? () => open(rowIds[index + 1])
          : page < totalPages
            ? turnPage(page + 1, 'first')
            : undefined,
    };
  }

  const place = lastPlace;
  if (!place || place.id !== openId || place.page !== page) return {};
  const nextId = rowIds[place.index];
  const previousId = place.index > 0 ? rowIds[place.index - 1] : undefined;
  return {
    onPrevious: previousId ? () => open(previousId) : page > 1 ? turnPage(page - 1, 'last') : undefined,
    onNext: nextId ? () => open(nextId) : page < totalPages ? turnPage(page + 1, 'first') : undefined,
  };
};

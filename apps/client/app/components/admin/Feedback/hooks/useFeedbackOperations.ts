import { useCallback, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useNavigate } from '@tanstack/react-router';
import { FeedbackStatus, adminAuditLogPath } from '@bike4mind/common';
import {
  deleteFeedbackFromServer,
  getFeedbackFromServer,
  updateFeedbackStatusOnServer,
} from '@client/app/utils/feedbackAPICalls';
import useToggle from '@client/app/hooks/useToggle';
import { adminActionCountsQueryKey } from '@client/app/hooks/data/adminActionCounts';
import { getErrorMessage } from '@client/app/utils/error';
import { useUndoToast } from '../../shared/UndoToast';
import { FeedbackListParams, IExtendedFeedbackDocument } from '../types';
import { UseFeedbackOperationsReturn } from '../types';
import { FEEDBACK_LIST_QUERY_KEY, FEEDBACK_ORGANIZATIONS_QUERY_KEY, FEEDBACK_RECORD_QUERY_KEY } from '../queryKeys';
import { FEEDBACK_STATUS_LABELS, FEEDBACK_TYPE_LABELS, feedbackTypeOf } from '../constants';

const formatReporter = (feedbackItem: IExtendedFeedbackDocument | undefined) => {
  if (!feedbackItem) return 'Unknown user';

  const user = feedbackItem.username || feedbackItem.userEmail || 'Unknown user';
  const hasOrganization = feedbackItem.organization && feedbackItem.organization !== 'Unknown';

  return hasOrganization ? `${user} (${feedbackItem.organization})` : user;
};

const feedbackTypeLabel = (feedbackItem: IExtendedFeedbackDocument | undefined) =>
  FEEDBACK_TYPE_LABELS[feedbackTypeOf(feedbackItem?.type)];

const showFeedbackToast = {
  success: (message: string) => toast.success(message, { closeButton: true, position: 'bottom-left' }),
  error: (message: string) => toast.error(message, { closeButton: true, position: 'bottom-left' }),
};

const getNextStatus = (currentStatus: FeedbackStatus): FeedbackStatus => {
  switch (currentStatus) {
    case FeedbackStatus.New:
      return FeedbackStatus.InProgress;
    case FeedbackStatus.InProgress:
      return FeedbackStatus.Closed;
    case FeedbackStatus.Closed:
      return FeedbackStatus.New;
    default:
      return currentStatus;
  }
};

/**
 * Reads one page of feedback from the server and owns the status/delete mutations.
 *
 * The org filter menu's options come from a SEPARATE query, deliberately unfiltered: folding them
 * into the list response would make the options disappear as soon as a filter narrowed the rows -
 * including the filter that is currently selected, which the reader then cannot clear.
 */
export const useFeedbackOperations = (params: FeedbackListParams): UseFeedbackOperationsReturn => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const showUndo = useUndoToast();
  const [feedbackToDelete, setFeedbackToDelete] = useState<string | null>(null);
  const [openDeleteFeedbackModal, toggleDeleteFeedbackModal] = useToggle();

  // No status checked matches nothing by definition. The tab never produces it (the status chip and
  // the URL both fall back to a status set), but skipping the request rather than omitting the param
  // keeps it matching nothing if a caller ever does: `status` absent means "any status" to the
  // server, which would invert the filter into showing every report.
  const hasStatusSelection = (params.status?.length ?? 0) > 0;

  const listQuery = useQuery({
    queryKey: [...FEEDBACK_LIST_QUERY_KEY, params],
    queryFn: () => getFeedbackFromServer(params),
    enabled: hasStatusSelection,
    // Keeps the previous page on screen while the next one loads, instead of flashing empty.
    placeholderData: keepPreviousData,
  });

  const organizationsQuery = useQuery({
    queryKey: FEEDBACK_ORGANIZATIONS_QUERY_KEY,
    // limit: 1 because only the `organizations` facet is wanted here; the rows are the list
    // query's job. This is the ONE request that opts into the facet - it is a full-collection
    // distinct for an admin, so the paged list and the CSV export must not carry it.
    queryFn: () => getFeedbackFromServer({ page: 1, limit: 1, sort: 'desc', includeOrganizations: true }),
    select: response => response.organizations ?? [],
  });

  const feedback = hasStatusSelection ? (listQuery.data?.items ?? []) : [];
  const total = hasStatusSelection ? (listQuery.data?.total ?? 0) : 0;
  // keepPreviousData shows the last query's rows (and total) while the next loads, so `total` only
  // describes these params once the list query has answered for them.
  const totalSettled = !hasStatusSelection || (listQuery.isSuccess && !listQuery.isPlaceholderData);

  const refreshFeedback = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: FEEDBACK_LIST_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: FEEDBACK_ORGANIZATIONS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: adminActionCountsQueryKey }),
      // The detail drawer reads its record from its own query, so a delete that refreshed only
      // the list would leave the drawer showing a report that no longer exists.
      queryClient.invalidateQueries({ queryKey: FEEDBACK_RECORD_QUERY_KEY }),
    ]);
  }, [queryClient]);

  const invalidateAfterStatusChange = useCallback(
    // Refetch rather than patch in place: the row may no longer match the active status filter, in
    // which case it belongs off this page entirely. The focused card reads the same record from a
    // separate query and has to move with it. The organization facet does not: a status change
    // cannot add or remove an org from the set that has any feedback.
    () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: FEEDBACK_LIST_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: FEEDBACK_RECORD_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: adminActionCountsQueryKey }),
      ]),
    [queryClient]
  );

  const openAuditEntry = useCallback(
    (entryId: string) => {
      const search = Object.fromEntries(new URL(adminAuditLogPath({}, entryId), 'http://local').searchParams);
      void navigate({ to: '/admin', search: search as never });
    },
    [navigate]
  );

  const handleStatusChange = useCallback(
    async (feedbackItem: IExtendedFeedbackDocument, newValue: FeedbackStatus | null) => {
      const previousStatus = feedbackItem.status;
      const updatedStatus = newValue ?? getNextStatus(previousStatus);
      if (updatedStatus === previousStatus) return;

      try {
        const result = await updateFeedbackStatusOnServer(feedbackItem._id, {
          status: updatedStatus,
          expectedStatus: previousStatus,
        });
        await invalidateAfterStatusChange();

        const { auditEntryId } = result;
        const label = `${feedbackTypeLabel(feedbackItem)} from ${formatReporter(feedbackItem)}`;
        showUndo({
          message: `${label} set to ${FEEDBACK_STATUS_LABELS[updatedStatus]}`,
          // Resolves even on failure: a retry would resend the same expectedStatus and fail again
          // (a 409 means the report moved), so the toast closes and the error goes to a plain toast.
          onUndo: async () => {
            try {
              await updateFeedbackStatusOnServer(feedbackItem._id, {
                status: previousStatus,
                expectedStatus: updatedStatus,
                ...(auditEntryId ? { undoOf: auditEntryId } : {}),
              });
              showFeedbackToast.success(`${label} set back to ${FEEDBACK_STATUS_LABELS[previousStatus]}`);
            } catch (error) {
              showFeedbackToast.error(`Could not undo: ${getErrorMessage(error)}`);
            }
            await invalidateAfterStatusChange();
          },
          ...(auditEntryId ? { onViewAudit: () => openAuditEntry(auditEntryId) } : {}),
        });
      } catch (error) {
        console.error('Error updating feedback status:', error);
        showFeedbackToast.error(`Failed to update feedback status: ${getErrorMessage(error)}`);
        // A 409 means someone else moved the report; show where it is now.
        await invalidateAfterStatusChange();
      }
    },
    [invalidateAfterStatusChange, openAuditEntry, showUndo]
  );

  const handleDeleteFeedbackClick = useCallback(
    (item: IExtendedFeedbackDocument) => {
      setFeedbackToDelete(item._id);
      toggleDeleteFeedbackModal();
    },
    [toggleDeleteFeedbackModal]
  );

  /** Rejects on failure so the ActionDialog stays open with the reason the admin entered. */
  const confirmDeleteFeedback = useCallback(
    async (reason: string) => {
      if (feedbackToDelete) {
        const deletedItem = feedback.find(item => item._id === feedbackToDelete);
        try {
          await deleteFeedbackFromServer(feedbackToDelete, reason);
        } catch (error) {
          console.error('Error deleting feedback:', error);
          showFeedbackToast.error(`Failed to delete feedback: ${getErrorMessage(error)}`);
          throw error;
        }
        await refreshFeedback();
        showFeedbackToast.success(`${feedbackTypeLabel(deletedItem)} from ${formatReporter(deletedItem)} deleted`);
      }

      toggleDeleteFeedbackModal();
      setFeedbackToDelete(null);
    },
    [feedbackToDelete, feedback, refreshFeedback, toggleDeleteFeedbackModal]
  );

  return {
    feedback,
    organizations: organizationsQuery.data ?? [],
    total,
    totalSettled,
    loading: (hasStatusSelection && listQuery.isFetching) || organizationsQuery.isFetching,
    isError: hasStatusSelection && listQuery.isError,
    refreshFeedback,
    handleStatusChange,
    handleDeleteFeedbackClick,
    confirmDeleteFeedback,
    feedbackToDelete,
    openDeleteFeedbackModal,
    toggleDeleteFeedbackModal,
  };
};

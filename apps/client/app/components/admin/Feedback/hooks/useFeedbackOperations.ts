import { useCallback, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FeedbackStatus } from '@bike4mind/common';
import {
  deleteFeedbackFromServer,
  getFeedbackFromServer,
  updateFeedbackOnServer,
} from '@client/app/utils/feedbackAPICalls';
import useToggle from '@client/app/hooks/useToggle';
import { getFeedbackDisplayContent, FeedbackListParams, IExtendedFeedbackDocument } from '../types';
import { UseFeedbackOperationsReturn } from '../types';
import { FEEDBACK_LIST_QUERY_KEY, FEEDBACK_ORGANIZATIONS_QUERY_KEY, FEEDBACK_RECORD_QUERY_KEY } from '../queryKeys';

const formatReporter = (feedbackItem: IExtendedFeedbackDocument | undefined) => {
  if (!feedbackItem) return 'Unknown user';

  const user = feedbackItem.username || feedbackItem.userEmail || 'Unknown user';
  const hasOrganization = feedbackItem.organization && feedbackItem.organization !== 'Unknown';

  return hasOrganization ? `${user} (${feedbackItem.organization})` : user;
};

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
  const [feedbackToDelete, setFeedbackToDelete] = useState<string | null>(null);
  const [openDeleteFeedbackModal, toggleDeleteFeedbackModal] = useToggle();

  // No status checked matches nothing by definition - the previous client-side predicate returned
  // an empty list for it. Skipping the request rather than omitting the param is what preserves
  // that: `status` absent means "any status" to the server, which would invert the filter into
  // showing every report.
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
    // query's job.
    queryFn: () => getFeedbackFromServer({ page: 1, limit: 1, sort: 'desc' }),
    select: response => response.organizations,
  });

  const feedback = hasStatusSelection ? (listQuery.data?.items ?? []) : [];
  const total = hasStatusSelection ? (listQuery.data?.total ?? 0) : 0;

  const refreshFeedback = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: FEEDBACK_LIST_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: FEEDBACK_ORGANIZATIONS_QUERY_KEY }),
      // A deep-linked record is pinned above the list from its own query, so a delete that
      // refreshed only the list would leave the card showing a report that no longer exists.
      queryClient.invalidateQueries({ queryKey: FEEDBACK_RECORD_QUERY_KEY }),
    ]);
  }, [queryClient]);

  const handleStatusChange = useCallback(
    async (feedbackItem: IExtendedFeedbackDocument, newValue: FeedbackStatus | null) => {
      const updatedStatus = newValue ?? getNextStatus(feedbackItem.status);

      try {
        const response = await updateFeedbackOnServer(feedbackItem._id, { ...feedbackItem, status: updatedStatus });
        if (!response) throw new Error('Failed to update feedback status');

        // Refetch rather than patch in place: the row may no longer match the active status
        // filter, in which case it belongs off this page entirely. The focused card reads the
        // same record from a separate query and has to move with it. The organization facet does
        // not: a status change cannot add or remove an org from the set that has any feedback.
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: FEEDBACK_LIST_QUERY_KEY }),
          queryClient.invalidateQueries({ queryKey: FEEDBACK_RECORD_QUERY_KEY }),
        ]);

        const content = getFeedbackDisplayContent(feedbackItem, 'No content');
        const preview = content.length > 50 ? content.substring(0, 50) + '...' : content;
        showFeedbackToast.success(
          `"${preview}" feedback from ${formatReporter(feedbackItem)} updated to: ${updatedStatus}`
        );
      } catch (error) {
        console.error('Error updating feedback status:', error);
        showFeedbackToast.error('Failed to update feedback status.');
      }
    },
    [queryClient]
  );

  const handleDeleteFeedbackClick = useCallback(
    (item: IExtendedFeedbackDocument) => {
      setFeedbackToDelete(item._id);
      toggleDeleteFeedbackModal();
    },
    [toggleDeleteFeedbackModal]
  );

  const confirmDeleteFeedback = useCallback(async () => {
    if (feedbackToDelete) {
      const deletedItem = feedback.find(item => item._id === feedbackToDelete);
      try {
        const response = await deleteFeedbackFromServer(feedbackToDelete);
        if (response) {
          await refreshFeedback();

          const deleteContent = getFeedbackDisplayContent(deletedItem, 'No content');
          const preview = deleteContent.length > 50 ? deleteContent.substring(0, 50) + '...' : deleteContent;
          showFeedbackToast.success(`"${preview}" feedback from ${formatReporter(deletedItem)} deleted successfully`);
        }
      } catch (error) {
        console.error('Error deleting feedback:', error);
        showFeedbackToast.error('Failed to delete feedback.');
      }
    }

    toggleDeleteFeedbackModal();
    setFeedbackToDelete(null);
  }, [feedbackToDelete, feedback, refreshFeedback, toggleDeleteFeedbackModal]);

  return {
    feedback,
    organizations: organizationsQuery.data ?? [],
    total,
    loading: (hasStatusSelection && listQuery.isFetching) || organizationsQuery.isFetching,
    refreshFeedback,
    handleStatusChange,
    handleDeleteFeedbackClick,
    confirmDeleteFeedback,
    feedbackToDelete,
    openDeleteFeedbackModal,
    toggleDeleteFeedbackModal,
  };
};

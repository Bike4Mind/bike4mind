import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { FeedbackStatus } from '@bike4mind/common';
import {
  getFeedbackFromServer,
  deleteFeedbackFromServer,
  updateFeedbackOnServer,
} from '@client/app/utils/feedbackAPICalls';
import useToggle from '@client/app/hooks/useToggle';
import { IExtendedFeedbackDocument, UseFeedbackOperationsReturn } from '../types';

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

export const useFeedbackOperations = (): UseFeedbackOperationsReturn => {
  const [feedback, setFeedback] = useState<IExtendedFeedbackDocument[]>([]);
  const [organizations, setOrganizations] = useState<string[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [feedbackToDelete, setFeedbackToDelete] = useState<string | null>(null);
  const [openDeleteFeedbackModal, toggleDeleteFeedbackModal] = useToggle();

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

  const refreshFeedback = async () => {
    setLoading(true);
    try {
      const feedbackData = await getFeedbackFromServer();
      const typedFeedbackData = feedbackData as IExtendedFeedbackDocument[];
      setFeedback(typedFeedbackData);

      const uniqueOrganizations = Array.from(new Set(typedFeedbackData.map(item => item.organization)));
      setOrganizations(uniqueOrganizations);
    } catch (error) {
      console.error('Error fetching feedback:', error);
      showFeedbackToast.error('Failed to load feedback data.');
    } finally {
      setLoading(false);
    }
  };

  const handleStatusChange = async (feedbackItem: IExtendedFeedbackDocument, newValue: FeedbackStatus | null) => {
    const updatedStatus = newValue ? newValue : getNextStatus(feedbackItem.status);
    const updatedFeedback = { ...feedbackItem, status: updatedStatus };

    try {
      const response = await updateFeedbackOnServer(feedbackItem._id, updatedFeedback);
      if (response) {
        setFeedback(prevFeedback =>
          prevFeedback.map(item => (item._id === feedbackItem._id ? { ...item, status: updatedStatus } : item))
        );
        const reporter = formatReporter(feedbackItem);
        const preview =
          feedbackItem.content.length > 50 ? feedbackItem.content.substring(0, 50) + '...' : feedbackItem.content;

        showFeedbackToast.success(`"${preview}" feedback from ${reporter} updated to: ${updatedStatus}`);
      } else {
        throw new Error('Failed to update feedback status');
      }
    } catch (error) {
      console.error('Error updating feedback status:', error);
      showFeedbackToast.error('Failed to update feedback status.');
    }
  };

  const handleDeleteFeedbackClick = (feedback: IExtendedFeedbackDocument) => {
    setFeedbackToDelete(feedback._id);
    toggleDeleteFeedbackModal();
  };

  const confirmDeleteFeedback = async () => {
    if (feedbackToDelete) {
      try {
        const response = await deleteFeedbackFromServer(feedbackToDelete);
        if (response) {
          setFeedback(prevFeedback => prevFeedback.filter(feedback => feedback._id !== feedbackToDelete));
          const feedbackToDeleteItem = feedback.find(f => f._id === feedbackToDelete);
          const reporter = formatReporter(feedbackToDeleteItem);
          const preview =
            feedbackToDeleteItem?.content && feedbackToDeleteItem.content.length > 50
              ? feedbackToDeleteItem.content.substring(0, 50) + '...'
              : feedbackToDeleteItem?.content || 'No content';

          showFeedbackToast.success(`"${preview}" feedback from ${reporter} deleted successfully`);
        }
      } catch (error) {
        console.error('Error deleting feedback:', error);
        showFeedbackToast.error('Failed to delete feedback.');
      }
    }

    toggleDeleteFeedbackModal();
    setFeedbackToDelete(null);
  };

  useEffect(() => {
    const loadFeedback = async () => {
      setLoading(true);
      try {
        const feedbackData = await getFeedbackFromServer();
        const typedFeedbackData = feedbackData as IExtendedFeedbackDocument[];
        setFeedback(typedFeedbackData);

        const uniqueOrganizations = Array.from(
          new Set(typedFeedbackData.map(item => item.organization).filter(Boolean))
        );
        setOrganizations(uniqueOrganizations);
      } catch (error) {
        console.error('Error loading feedback:', error);
        showFeedbackToast.error('Failed to load feedback data.');
      } finally {
        setLoading(false);
      }
    };

    loadFeedback();
  }, []);

  return {
    feedback,
    organizations,
    loading,
    refreshFeedback,
    handleStatusChange,
    handleDeleteFeedbackClick,
    confirmDeleteFeedback,
    feedbackToDelete,
    openDeleteFeedbackModal,
    toggleDeleteFeedbackModal,
  };
};

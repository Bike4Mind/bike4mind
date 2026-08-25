import { useState, useMemo } from 'react';
import { FeedbackStatus } from '@bike4mind/common';
import { useOrganizationContext } from '@client/app/contexts/OrganizationContext';
import { IExtendedFeedbackDocument, FeedbackFilters, UseFeedbackFiltersReturn } from '../types';

const statusOrder = [FeedbackStatus.New, FeedbackStatus.InProgress, FeedbackStatus.Closed];

export const useFeedbackFilters = (feedback: IExtendedFeedbackDocument[]): UseFeedbackFiltersReturn => {
  const { selectedOrganization } = useOrganizationContext();

  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilters, setStatusFilters] = useState<Record<FeedbackStatus, boolean>>({
    [FeedbackStatus.New]: true,
    [FeedbackStatus.InProgress]: false,
    [FeedbackStatus.Closed]: false,
  });
  const [selectedOrganizations, setSelectedOrganizations] = useState<string[]>([]);
  const [sortAscending, setSortAscending] = useState<boolean>(false);

  const filters: FeedbackFilters = {
    searchTerm,
    statusFilters,
    selectedOrganizations,
    sortAscending,
  };

  const toggleSortDirection = () => {
    setSortAscending(!sortAscending);
  };

  const filteredAndSortedFeedback = useMemo(() => {
    return feedback
      .filter(feedbackItem => {
        const matchesStatus = statusFilters[feedbackItem.status];
        const matchesOrganization =
          selectedOrganization && selectedOrganization.length > 0
            ? selectedOrganization.includes('all') || selectedOrganization.includes(feedbackItem.organization)
            : true;
        const matchesSearchTerm = searchTerm
          ? feedbackItem.username.toLowerCase().includes(searchTerm.toLowerCase()) ||
            feedbackItem.content.toLowerCase().includes(searchTerm.toLowerCase())
          : true;
        return matchesStatus && matchesOrganization && matchesSearchTerm;
      })
      .sort((a, b) => {
        const statusComparison = statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status);
        if (statusComparison !== 0) return statusComparison;
        return sortAscending
          ? new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
          : new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
  }, [feedback, statusFilters, selectedOrganization, searchTerm, sortAscending]);

  return {
    filters,
    setSearchTerm,
    setStatusFilters,
    setSelectedOrganizations,
    toggleSortDirection,
    filteredAndSortedFeedback,
  };
};

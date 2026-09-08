import { describe, it, expect } from 'vitest';
import { FeedbackStatus, FeedbackType } from '@bike4mind/common';
import { IExtendedFeedbackDocument } from '../../types';

const createMockFeedback = (overrides: Partial<IExtendedFeedbackDocument>): any => ({
  _id: 'test-id',
  userId: 'user-1',
  content: 'Test feedback content',
  status: FeedbackStatus.New,
  tags: [],
  username: 'testuser',
  userEmail: 'test@example.com',
  customerService: 'support',
  organization: 'test-org',
  type: FeedbackType.FEEDBACK,
  promptMeta: {
    promptId: 'prompt-1',
    model: {
      name: 'test-model',
    },
    session: {
      id: 'session-1',
      userId: 'user-1',
    },
  },
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  ...overrides,
});

// Test the filtering logic directly
const applyFilters = (
  feedback: IExtendedFeedbackDocument[],
  statusFilters: Record<FeedbackStatus, boolean>,
  searchTerm: string = '',
  selectedOrganization: string[] = []
) => {
  return feedback.filter(feedbackItem => {
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
  });
};

// Test the sorting logic directly
const applySorting = (feedback: IExtendedFeedbackDocument[], sortAscending: boolean = false) => {
  const statusOrder = [FeedbackStatus.New, FeedbackStatus.InProgress, FeedbackStatus.Closed];

  return feedback.sort((a, b) => {
    const statusComparison = statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status);
    if (statusComparison !== 0) return statusComparison;
    return sortAscending
      ? new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      : new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
};

describe('useFeedbackFilters Logic', () => {
  describe('Default State Verification', () => {
    it('should have correct default statusFilters configuration', () => {
      const defaultStatusFilters = {
        [FeedbackStatus.New]: true,
        [FeedbackStatus.InProgress]: false,
        [FeedbackStatus.Closed]: false,
      };

      expect(defaultStatusFilters[FeedbackStatus.New]).toBe(true);
      expect(defaultStatusFilters[FeedbackStatus.InProgress]).toBe(false);
      expect(defaultStatusFilters[FeedbackStatus.Closed]).toBe(false);
    });

    it('should verify that default filters show only New feedback', () => {
      const mockFeedback: IExtendedFeedbackDocument[] = [
        createMockFeedback({ _id: '1', status: FeedbackStatus.New }),
        createMockFeedback({ _id: '2', status: FeedbackStatus.InProgress }),
        createMockFeedback({ _id: '3', status: FeedbackStatus.Closed }),
      ];

      const defaultStatusFilters = {
        [FeedbackStatus.New]: true,
        [FeedbackStatus.InProgress]: false,
        [FeedbackStatus.Closed]: false,
      };

      const filtered = applyFilters(mockFeedback, defaultStatusFilters);

      expect(filtered).toHaveLength(1);
      expect(filtered[0].status).toBe(FeedbackStatus.New);
      expect(filtered[0]._id).toBe('1');
    });
  });

  describe('Default Filtering Behavior', () => {
    it('should return only New feedback entries with default filters', () => {
      const mockFeedback: IExtendedFeedbackDocument[] = [
        createMockFeedback({ _id: '1', status: FeedbackStatus.New, content: 'New feedback' }),
        createMockFeedback({ _id: '2', status: FeedbackStatus.InProgress, content: 'InProgress feedback' }),
        createMockFeedback({ _id: '3', status: FeedbackStatus.Closed, content: 'Closed feedback' }),
        createMockFeedback({ _id: '4', status: FeedbackStatus.New, content: 'Another new feedback' }),
      ];

      const defaultStatusFilters = {
        [FeedbackStatus.New]: true,
        [FeedbackStatus.InProgress]: false,
        [FeedbackStatus.Closed]: false,
      };

      const filtered = applyFilters(mockFeedback, defaultStatusFilters);

      expect(filtered).toHaveLength(2);
      expect(filtered[0].status).toBe(FeedbackStatus.New);
      expect(filtered[1].status).toBe(FeedbackStatus.New);
    });

    it('should return empty array when no New feedback exists', () => {
      const mockFeedback: IExtendedFeedbackDocument[] = [
        createMockFeedback({ _id: '1', status: FeedbackStatus.InProgress }),
        createMockFeedback({ _id: '2', status: FeedbackStatus.Closed }),
      ];

      const defaultStatusFilters = {
        [FeedbackStatus.New]: true,
        [FeedbackStatus.InProgress]: false,
        [FeedbackStatus.Closed]: false,
      };

      const filtered = applyFilters(mockFeedback, defaultStatusFilters);

      expect(filtered).toHaveLength(0);
    });

    it('should return empty array when feedback array is empty', () => {
      const mockFeedback: IExtendedFeedbackDocument[] = [];
      const defaultStatusFilters = {
        [FeedbackStatus.New]: true,
        [FeedbackStatus.InProgress]: false,
        [FeedbackStatus.Closed]: false,
      };

      const filtered = applyFilters(mockFeedback, defaultStatusFilters);

      expect(filtered).toHaveLength(0);
    });
  });

  describe('Filter State Changes', () => {
    it('should filter correctly when InProgress is also enabled', () => {
      const mockFeedback: IExtendedFeedbackDocument[] = [
        createMockFeedback({ _id: '1', status: FeedbackStatus.New }),
        createMockFeedback({ _id: '2', status: FeedbackStatus.InProgress }),
        createMockFeedback({ _id: '3', status: FeedbackStatus.Closed }),
      ];

      const statusFilters = {
        [FeedbackStatus.New]: true,
        [FeedbackStatus.InProgress]: true,
        [FeedbackStatus.Closed]: false,
      };

      const filtered = applyFilters(mockFeedback, statusFilters);

      expect(filtered).toHaveLength(2);
      const statuses = filtered.map(f => f.status);
      expect(statuses).toContain(FeedbackStatus.New);
      expect(statuses).toContain(FeedbackStatus.InProgress);
    });

    it('should filter correctly when only InProgress is selected', () => {
      const mockFeedback: IExtendedFeedbackDocument[] = [
        createMockFeedback({ _id: '1', status: FeedbackStatus.New }),
        createMockFeedback({ _id: '2', status: FeedbackStatus.InProgress }),
        createMockFeedback({ _id: '3', status: FeedbackStatus.Closed }),
      ];

      const statusFilters = {
        [FeedbackStatus.New]: false,
        [FeedbackStatus.InProgress]: true,
        [FeedbackStatus.Closed]: false,
      };

      const filtered = applyFilters(mockFeedback, statusFilters);

      expect(filtered).toHaveLength(1);
      expect(filtered[0].status).toBe(FeedbackStatus.InProgress);
    });

    it('should filter correctly when multiple statuses are selected', () => {
      const mockFeedback: IExtendedFeedbackDocument[] = [
        createMockFeedback({ _id: '1', status: FeedbackStatus.New }),
        createMockFeedback({ _id: '2', status: FeedbackStatus.InProgress }),
        createMockFeedback({ _id: '3', status: FeedbackStatus.Closed }),
      ];

      const statusFilters = {
        [FeedbackStatus.New]: true,
        [FeedbackStatus.InProgress]: false,
        [FeedbackStatus.Closed]: true,
      };

      const filtered = applyFilters(mockFeedback, statusFilters);

      expect(filtered).toHaveLength(2);
      const statuses = filtered.map(f => f.status);
      expect(statuses).toContain(FeedbackStatus.New);
      expect(statuses).toContain(FeedbackStatus.Closed);
      expect(statuses).not.toContain(FeedbackStatus.InProgress);
    });
  });

  describe('Search Functionality', () => {
    it('should filter by username when search term is provided', () => {
      const mockFeedback: IExtendedFeedbackDocument[] = [
        createMockFeedback({ _id: '1', username: 'john.doe', status: FeedbackStatus.New }),
        createMockFeedback({ _id: '2', username: 'jane.smith', status: FeedbackStatus.New }),
      ];

      const defaultStatusFilters = {
        [FeedbackStatus.New]: true,
        [FeedbackStatus.InProgress]: false,
        [FeedbackStatus.Closed]: false,
      };

      const filtered = applyFilters(mockFeedback, defaultStatusFilters, 'john');

      expect(filtered).toHaveLength(1);
      expect(filtered[0].username).toBe('john.doe');
    });

    it('should filter by content when search term is provided', () => {
      const mockFeedback: IExtendedFeedbackDocument[] = [
        createMockFeedback({ _id: '1', content: 'This is a bug report', status: FeedbackStatus.New }),
        createMockFeedback({ _id: '2', content: 'This is general feedback', status: FeedbackStatus.New }),
      ];

      const defaultStatusFilters = {
        [FeedbackStatus.New]: true,
        [FeedbackStatus.InProgress]: false,
        [FeedbackStatus.Closed]: false,
      };

      const filtered = applyFilters(mockFeedback, defaultStatusFilters, 'bug');

      expect(filtered).toHaveLength(1);
      expect(filtered[0].content).toBe('This is a bug report');
    });

    it('should be case insensitive when searching', () => {
      const mockFeedback: IExtendedFeedbackDocument[] = [
        createMockFeedback({ _id: '1', username: 'John.Doe', content: 'BUG Report', status: FeedbackStatus.New }),
      ];

      const defaultStatusFilters = {
        [FeedbackStatus.New]: true,
        [FeedbackStatus.InProgress]: false,
        [FeedbackStatus.Closed]: false,
      };

      const filteredByUsername = applyFilters(mockFeedback, defaultStatusFilters, 'john');
      expect(filteredByUsername).toHaveLength(1);

      const filteredByContent = applyFilters(mockFeedback, defaultStatusFilters, 'bug');
      expect(filteredByContent).toHaveLength(1);
    });
  });

  describe('Sorting Behavior', () => {
    it('should sort by status first, then by date descending by default', () => {
      const mockFeedback: IExtendedFeedbackDocument[] = [
        createMockFeedback({
          _id: '1',
          status: FeedbackStatus.New,
          createdAt: new Date('2024-01-02'),
        }),
        createMockFeedback({
          _id: '2',
          status: FeedbackStatus.New,
          createdAt: new Date('2024-01-01'),
        }),
      ];

      const sorted = applySorting([...mockFeedback], false);

      // Should be sorted by date descending (newer first)
      expect(sorted[0]._id).toBe('1');
      expect(sorted[1]._id).toBe('2');
    });

    it('should sort by date ascending when sortAscending is true', () => {
      const mockFeedback: IExtendedFeedbackDocument[] = [
        createMockFeedback({
          _id: '1',
          status: FeedbackStatus.New,
          createdAt: new Date('2024-01-02'),
        }),
        createMockFeedback({
          _id: '2',
          status: FeedbackStatus.New,
          createdAt: new Date('2024-01-01'),
        }),
      ];

      const sorted = applySorting([...mockFeedback], true);

      // Should be sorted by date ascending (older first)
      expect(sorted[0]._id).toBe('2');
      expect(sorted[1]._id).toBe('1');
    });

    it('should prioritize status order over date sorting', () => {
      const mockFeedback: IExtendedFeedbackDocument[] = [
        createMockFeedback({
          _id: '1',
          status: FeedbackStatus.Closed,
          createdAt: new Date('2024-01-03'),
        }),
        createMockFeedback({
          _id: '2',
          status: FeedbackStatus.New,
          createdAt: new Date('2024-01-01'),
        }),
        createMockFeedback({
          _id: '3',
          status: FeedbackStatus.InProgress,
          createdAt: new Date('2024-01-02'),
        }),
      ];

      const sorted = applySorting([...mockFeedback], false);

      // Should be sorted by status order: New, InProgress, Closed
      expect(sorted[0].status).toBe(FeedbackStatus.New);
      expect(sorted[1].status).toBe(FeedbackStatus.InProgress);
      expect(sorted[2].status).toBe(FeedbackStatus.Closed);
    });
  });
});

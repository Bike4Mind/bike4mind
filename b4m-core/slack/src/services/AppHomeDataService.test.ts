import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppHomeDataService, formatRelativeTime } from './AppHomeDataService';

// Create mock query builder
const createMockQuery = (resolvedValue: unknown) => ({
  select: vi.fn().mockReturnThis(),
  sort: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  lean: vi.fn().mockResolvedValue(resolvedValue),
});

// Mock the database models
const mockSessionFind = vi.fn();
const mockSessionCountDocuments = vi.fn();
const mockQuestCountDocuments = vi.fn();
const mockProjectFind = vi.fn();

vi.mock('../di/registry', () => ({
  getSlackDb: () => ({
    Session: {
      find: (...args: unknown[]) => mockSessionFind(...args),
      countDocuments: (...args: unknown[]) => mockSessionCountDocuments(...args),
    },
    Quest: {
      countDocuments: (...args: unknown[]) => mockQuestCountDocuments(...args),
    },
    Project: {
      find: (...args: unknown[]) => mockProjectFind(...args),
    },
  }),
}));

// Mock Logger
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('AppHomeDataService', () => {
  let service: AppHomeDataService;
  const mockUserId = 'user123';

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AppHomeDataService(mockLogger as any);
  });

  describe('fetchRecentNotebooks', () => {
    it('should fetch and transform recent notebooks', async () => {
      const mockSessions = [
        { _id: { toString: () => 'session1' }, name: 'Notebook 1', lastUpdated: new Date(), messageCount: 5 },
        { _id: { toString: () => 'session2' }, name: 'Notebook 2', lastUpdated: new Date(), messageCount: 3 },
      ];

      const mockQuery = createMockQuery(mockSessions);
      mockSessionFind.mockReturnValue(mockQuery);

      const result = await service.fetchRecentNotebooks(mockUserId, 5);

      expect(mockSessionFind).toHaveBeenCalledWith({ userId: mockUserId, deletedAt: { $exists: false } });
      expect(mockQuery.select).toHaveBeenCalledWith('name lastUpdated messageCount');
      expect(mockQuery.sort).toHaveBeenCalledWith({ lastUpdated: -1 });
      expect(mockQuery.limit).toHaveBeenCalledWith(5);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        id: 'session1',
        name: 'Notebook 1',
        lastUpdated: mockSessions[0].lastUpdated,
        messageCount: 5,
      });
    });

    it('should return empty array on error', async () => {
      const mockQuery = createMockQuery([]);
      mockQuery.lean.mockRejectedValue(new Error('DB error'));
      mockSessionFind.mockReturnValue(mockQuery);

      const result = await service.fetchRecentNotebooks(mockUserId);

      expect(result).toEqual([]);
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should return empty array when no notebooks exist', async () => {
      const mockQuery = createMockQuery([]);
      mockSessionFind.mockReturnValue(mockQuery);

      const result = await service.fetchRecentNotebooks(mockUserId);

      expect(result).toEqual([]);
    });

    it('should respect the limit parameter', async () => {
      const mockQuery = createMockQuery([]);
      mockSessionFind.mockReturnValue(mockQuery);

      await service.fetchRecentNotebooks(mockUserId, 10);

      expect(mockQuery.limit).toHaveBeenCalledWith(10);
    });
  });

  describe('fetchAppHomeData', () => {
    it('should fetch notebooks, stats, and projects in parallel', async () => {
      const mockDate = new Date();
      const mockSessions = [
        { _id: { toString: () => 'session1' }, name: 'Notebook 1', lastUpdated: mockDate, messageCount: 5 },
      ];
      const mockSessionIds = [{ _id: 'session1' }, { _id: 'session2' }, { _id: 'session3' }];
      const mockProjectIds = [{ _id: 'project1' }, { _id: 'project2' }];

      // Mock Session.find calls
      const mockNotebookQuery = createMockQuery(mockSessions);
      const mockIdQuery = createMockQuery(mockSessionIds);
      const mockProjectQuery = createMockQuery(mockProjectIds);

      mockSessionFind.mockReturnValue(mockIdQuery);
      mockSessionFind.mockReturnValueOnce(mockNotebookQuery); // First call: fetchRecentNotebooks
      mockSessionFind.mockReturnValueOnce(mockIdQuery); // Second call: notebook count
      mockSessionFind.mockReturnValueOnce(mockIdQuery); // Third call: messages query

      mockProjectFind.mockReturnValue(mockProjectQuery);
      mockQuestCountDocuments.mockResolvedValue(10);

      const result = await service.fetchAppHomeData(mockUserId);

      expect(result.notebooks).toHaveLength(1);
      expect(result.stats.totalNotebooks).toBe(3);
      expect(result.stats.messagesThisWeek).toBe(10);
      expect(result.stats.activeProjects).toBe(2);
    });

    it('should return zeros when no data exists', async () => {
      const mockEmptyQuery = createMockQuery([]);

      mockSessionFind.mockReturnValue(mockEmptyQuery);
      mockProjectFind.mockReturnValue(mockEmptyQuery);

      const result = await service.fetchAppHomeData(mockUserId);

      expect(result.notebooks).toEqual([]);
      expect(result.stats.totalNotebooks).toBe(0);
      expect(result.stats.messagesThisWeek).toBe(0);
      expect(result.stats.activeProjects).toBe(0);
    });
  });

  describe('fetchUserStats', () => {
    it('should return stats with notebook count, messages, and projects', async () => {
      mockSessionCountDocuments.mockResolvedValue(5);

      const mockSessionQuery = createMockQuery([{ _id: 'session1' }]);
      const mockProjectQuery = createMockQuery([{ _id: 'project1' }, { _id: 'project2' }]);

      mockSessionFind.mockReturnValue(mockSessionQuery);
      mockProjectFind.mockReturnValue(mockProjectQuery);
      mockQuestCountDocuments.mockResolvedValue(25);

      const result = await service.fetchUserStats(mockUserId);

      expect(result.totalNotebooks).toBe(5);
      expect(result.messagesThisWeek).toBe(25);
      expect(result.activeProjects).toBe(2);
    });

    it('should return zeros on error', async () => {
      mockSessionCountDocuments.mockRejectedValue(new Error('DB error'));

      const result = await service.fetchUserStats(mockUserId);

      expect(result).toEqual({ totalNotebooks: 0, messagesThisWeek: 0, activeProjects: 0 });
      expect(mockLogger.error).toHaveBeenCalled();
    });

    // Regression guard for #610: membership rows store userId, so the active-project
    // count must query users.userId, not the nonexistent users.id.
    it('counts active projects via the stored users.userId membership path, never users.id (#610)', async () => {
      mockSessionCountDocuments.mockResolvedValue(0);
      mockSessionFind.mockReturnValue(createMockQuery([]));
      mockProjectFind.mockReturnValue(createMockQuery([{ _id: 'project1' }]));
      mockQuestCountDocuments.mockResolvedValue(0);

      await service.fetchUserStats(mockUserId);

      const [query] = mockProjectFind.mock.calls[0] as [{ $or: Array<Record<string, unknown>> }];
      expect(query.$or).toEqual(expect.arrayContaining([{ userId: mockUserId }, { 'users.userId': mockUserId }]));
      expect(query.$or.flatMap(clause => Object.keys(clause))).not.toContain('users.id');
    });
  });
});

describe('formatRelativeTime', () => {
  it('should return "Just now" for times less than 1 minute ago', () => {
    const now = new Date();
    expect(formatRelativeTime(now)).toBe('Just now');
  });

  it('should return "1 minute ago" for 1 minute ago', () => {
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
    expect(formatRelativeTime(oneMinuteAgo)).toBe('1 minute ago');
  });

  it('should return "X minutes ago" for times less than 1 hour', () => {
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
    expect(formatRelativeTime(thirtyMinutesAgo)).toBe('30 minutes ago');
  });

  it('should return "1 hour ago" for 1 hour ago', () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    expect(formatRelativeTime(oneHourAgo)).toBe('1 hour ago');
  });

  it('should return "X hours ago" for times less than 24 hours', () => {
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
    expect(formatRelativeTime(fiveHoursAgo)).toBe('5 hours ago');
  });

  it('should return "Yesterday" for 1 day ago', () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    expect(formatRelativeTime(yesterday)).toBe('Yesterday');
  });

  it('should return "X days ago" for times less than 7 days', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    expect(formatRelativeTime(threeDaysAgo)).toBe('3 days ago');
  });

  it('should return formatted date for times 7+ days ago', () => {
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const result = formatRelativeTime(twoWeeksAgo);
    // Should be in format like "Jan 9" (month and day)
    expect(result).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });
});

import { Logger } from '@bike4mind/observability';
import { getSlackDb } from '../di/registry';

/**
 * Notebook data for App Home display
 */
export interface AppHomeNotebook {
  id: string;
  name: string;
  lastUpdated: Date;
  messageCount?: number;
}

/**
 * User statistics for App Home display
 */
export interface AppHomeStats {
  totalNotebooks: number;
  messagesThisWeek: number;
  activeProjects: number;
}

/**
 * Combined data for App Home personalized content
 */
export interface AppHomeData {
  notebooks: AppHomeNotebook[];
  stats: AppHomeStats;
}

/**
 * Service for fetching personalized App Home data
 */
export class AppHomeDataService {
  private logger: Logger;

  constructor(logger?: Logger) {
    this.logger = logger || new Logger({ metadata: { component: 'AppHomeDataService' } });
  }

  /**
   * Fetch all personalized data for App Home
   */
  async fetchAppHomeData(userId: string): Promise<AppHomeData> {
    const { Session } = getSlackDb();
    // Parallel fetch: notebooks for display + lightweight count queries
    // Using find().select('_id') for counts to avoid DocumentDB countDocuments quirk
    const [notebooks, notebookIds, messagesThisWeek, projectIds] = await Promise.all([
      this.fetchRecentNotebooks(userId, 5),
      (Session as any)
        .find({ userId, deletedAt: { $exists: false } })
        .select('_id')
        .lean(),
      this.countMessagesThisWeek(userId),
      this.countActiveProjects(userId),
    ]);

    return {
      notebooks,
      stats: {
        totalNotebooks: notebookIds.length,
        messagesThisWeek,
        activeProjects: projectIds,
      },
    };
  }

  /**
   * Fetch user's recent notebooks (last 5)
   */
  async fetchRecentNotebooks(userId: string, limit: number = 5): Promise<AppHomeNotebook[]> {
    try {
      const { Session } = getSlackDb();
      const sessions = await (Session as any)
        .find({ userId, deletedAt: { $exists: false } })
        .select('name lastUpdated messageCount')
        .sort({ lastUpdated: -1 })
        .limit(limit)
        .lean();

      return sessions.map((session: any) => ({
        id: session._id.toString(),
        name: session.name,
        lastUpdated: session.lastUpdated,
        messageCount: session.messageCount,
      }));
    } catch (error) {
      this.logger.error('[AppHomeDataService] Failed to fetch recent notebooks', { userId, error });
      return [];
    }
  }

  /**
   * Fetch user statistics
   */
  async fetchUserStats(userId: string): Promise<AppHomeStats> {
    try {
      const [totalNotebooks, messagesThisWeek, activeProjects] = await Promise.all([
        this.countTotalNotebooks(userId),
        this.countMessagesThisWeek(userId),
        this.countActiveProjects(userId),
      ]);

      return { totalNotebooks, messagesThisWeek, activeProjects };
    } catch (error) {
      this.logger.error('[AppHomeDataService] Failed to fetch user stats', { userId, error });
      return { totalNotebooks: 0, messagesThisWeek: 0, activeProjects: 0 };
    }
  }

  /**
   * Count total notebooks for user
   */
  private async countTotalNotebooks(userId: string): Promise<number> {
    const { Session } = getSlackDb();
    return (Session as any).countDocuments({ userId, deletedAt: { $exists: false } });
  }

  /**
   * Count messages from the last 7 days
   */
  private async countMessagesThisWeek(userId: string): Promise<number> {
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    const { Session, Quest } = getSlackDb();
    // First get user's session IDs (exclude deleted)
    const sessions = await (Session as any)
      .find({ userId, deletedAt: { $exists: false } })
      .select('_id')
      .lean();
    const sessionIds = sessions.map((s: { _id: { toString(): string } }) => s._id.toString());

    if (sessionIds.length === 0) {
      return 0;
    }

    // Count messages in those sessions from the last week
    return (Quest as any).countDocuments({
      sessionId: { $in: sessionIds },
      timestamp: { $gte: oneWeekAgo },
    });
  }

  /**
   * Count active projects for user (owner or member)
   */
  private async countActiveProjects(userId: string): Promise<number> {
    const { Project } = getSlackDb();
    // Using find().select('_id') to avoid DocumentDB countDocuments quirk
    const projects = await (Project as any)
      .find({
        $or: [
          { userId }, // User is owner
          // Membership rows store userId (sharingService pushShareable); path is users.userId, not users.id.
          { 'users.userId': userId }, // User is member
        ],
        deletedAt: { $exists: false },
      })
      .select('_id')
      .lean();

    return projects.length;
  }
}

/**
 * Format relative time for display (e.g., "2 hours ago", "Yesterday")
 */
export function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) {
    return 'Just now';
  } else if (diffMins < 60) {
    return `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
  } else if (diffHours < 24) {
    return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  } else if (diffDays === 1) {
    return 'Yesterday';
  } else if (diffDays < 7) {
    return `${diffDays} days ago`;
  } else {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
}

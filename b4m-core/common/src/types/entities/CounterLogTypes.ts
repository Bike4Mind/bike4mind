import { IMongoDocument } from './common';
import { IUserDocument } from './UserTypes';
import type { FacetResults } from './AnalyticsTypes';

export interface ICounterLog {
  userId: string;
  userName: string;
  userTags: string[];
  userLevel: string;
  userOrganization: string;
  counterName: string;
  counterTags: string[];
  counterValue: number;
  datetime: Date;
  metadata?: Record<string, unknown>;
}

export interface ICounterLogDocument extends ICounterLog, IMongoDocument {}

export interface TopUserResult {
  _id: string;
  userName?: string;
  email: string;
  interactions: number;
  rankChange?: 'up' | 'down' | 'new' | 'same';
  lastWeekRank?: number | 'new' | '>#20';
}

export interface AggregationResult {
  _id: string;
  count: number;
}

export interface ICounterLogRepository {
  /**
   * Find the 10 most recent counter logs for a user
   * @param userId - The ID of the user.
   * @returns A promise that resolves to an array of counter logs.
   */
  findRecentByUserIdAndHasMetadata: (userId: string) => Promise<ICounterLogDocument[]>;

  /**
   * Find the 10 most recent counter logs for a user filtered by counter names
   * @param userId - The ID of the user
   * @param counterNames - Array of counter names to filter by
   * @returns A promise that resolves to an array of counter logs
   */
  findRecentByUserIdAndCounterNamesAndHasMetadata: (
    userId: string,
    counterNames: string[]
  ) => Promise<ICounterLogDocument[]>;

  /**
   * Get metrics aggregated by date
   * @param date - The date to get metrics for
   * @param startDate - Optional start date for weekly reports
   * @returns A promise that resolves to faceted results
   */
  metricsByDate: (date: string, startDate?: string) => Promise<FacetResults[]>;

  /**
   * Find all counter logs with associated user data for a specific date
   * @param date - The date to find logs for
   * @returns A promise that resolves to counter logs with user data
   */
  findAllWithUserByDate: (date: string) => Promise<(ICounterLog & { user: IUserDocument })[]>;

  /**
   * Find all counter logs with associated user data for a date range
   * @param startDate - The start date to find logs from
   * @param endDate - The end date to find logs to
   * @returns A promise that resolves to counter logs with user data
   */
  findAllWithUserByDateRange: (
    startDate: string,
    endDate: string
  ) => Promise<(ICounterLog & { user: IUserDocument })[]>;
}

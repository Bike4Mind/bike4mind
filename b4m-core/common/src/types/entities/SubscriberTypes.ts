import { IBaseRepository, IMongoDocument } from '.';
import { PaginatedResponse } from '../common';

/**
 * Base interface for subscriber data
 */
export interface ISubscriber {
  firstName: string;
  lastName: string;
  email: string;
  createdAt: Date;
  // Soft delete support
  deletedAt?: Date | null;
  // Invite generation tracking
  inviteGenerated?: boolean;
  inviteCode?: string;
  inviteGeneratedAt?: Date;
  inviteGeneratedBy?: string; // Admin user ID who generated the invite
  startingCredits?: number;
  startingStorage?: number;
}

export interface ISubscriberDocument extends ISubscriber, IMongoDocument {}

/**
 * Repository interface for subscriber operations
 */
export interface ISubscriberRepository extends IBaseRepository<ISubscriberDocument> {
  findByEmail: (email: string) => Promise<ISubscriberDocument | null>;
  listSubscribers: (options: {
    page: number;
    limit: number;
    search?: string;
  }) => Promise<PaginatedResponse<ISubscriberDocument>>;
  markInviteGenerated: (
    id: string,
    inviteCode: string,
    adminId: string,
    credits: number,
    storage: number
  ) => Promise<ISubscriberDocument>;
  countWaiting: () => Promise<number>;
}

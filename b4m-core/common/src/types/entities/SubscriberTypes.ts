import { IBaseRepository, IMongoDocument } from '.';
import { PaginatedResponse } from '../common';

/**
 * Where a waitlist signup came from. Everything but `subscribe_page` is a person who
 * tried to create an account while open registration was off.
 */
export const SUBSCRIBER_SOURCES = [
  'subscribe_page',
  'login_signup_closed',
  'register_signup_closed',
  'oauth_signup_closed',
] as const;

export type SubscriberSource = (typeof SUBSCRIBER_SOURCES)[number];

/**
 * Why a waitlist name looks like a probe rather than a person: HTML or script markup, a leading
 * spreadsheet-formula character, or control characters. Flagged rows are stored (the response stays
 * uniform) but never posted to Slack.
 */
export const SUBSCRIBER_SUSPICIOUS_REASONS = ['markup', 'formula_prefix', 'control_characters'] as const;
export type SubscriberSuspiciousReason = (typeof SUBSCRIBER_SUSPICIOUS_REASONS)[number];

/**
 * The network a waitlist signup came from, read the way an account signup's signupMeta is
 * (apps/client server/auth/networkMeta.ts) but kept smaller: the IP is stored truncated (/24 or /48),
 * never in full, and the whole object is cleared once it is older than the retention window
 * (SUBSCRIBER_NETWORK_RETENTION_DAYS, apps/workers cron/subscriberNetworkRetention.ts).
 */
export interface ISubscriberSignupNetwork {
  ipPrefix: string | null;
  userAgent: string | null;
  asn: number | null;
  asnOrg: string | null;
  /** ISO 3166-1 alpha-2. */
  country: string | null;
  isDatacenter: boolean | null;
  ja4: string | null;
  wafAnonIp: boolean | null;
  wafBotSignal: boolean | null;
  /** True when a Turnstile token passed server-side; null when it was not checked (policy off, e2e). */
  challengeVerified: true | null;
  capturedAt: Date;
}

export const SUBSCRIBER_NETWORK_RETENTION_DAYS = 90;

/**
 * Base interface for subscriber data
 */
export interface ISubscriber {
  firstName: string;
  lastName: string;
  email: string;
  source?: SubscriberSource;
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
  signupNetwork?: ISubscriberSignupNetwork | null;
  suspicious?: { reasons: SubscriberSuspiciousReason[] } | null;
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
  /** Drop signupNetwork from rows captured before `cutoff`; returns how many rows were cleared. */
  clearSignupNetworkBefore: (cutoff: Date) => Promise<number>;
}

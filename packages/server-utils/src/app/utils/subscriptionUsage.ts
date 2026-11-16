import { z } from 'zod';

export const SUBSCRIPTION_USAGE_COHORTS = ['payingNoRecorded', 'cancelingRecent'] as const;
export const SUBSCRIPTION_USAGE_DAYS = 28;
export const SubscriptionUsageQuerySchema = z.object({ subscriptionId: z.string().regex(/^[a-f\d]{24}$/i) });

export type SubscriptionUsage = {
  from: string;
  to: string;
  queriedAt: string;
  recordedSince: string | null;
  latestRecordedAt: string | null;
  coverage: 'observed' | 'incomplete' | 'new' | 'internal' | 'unknown' | 'unavailable';
  firstPartyRequests: number | null;
  apiRequests: number | null;
  creditsConsumed: number | null;
  lastSuccessfulAt: string | null;
  successfulRequests: number;
  recordedEvents: number;
};

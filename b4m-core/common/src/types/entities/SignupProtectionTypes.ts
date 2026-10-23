import { z } from 'zod';

export type SignupObservation = { userId: string; email: string; domain: string; verifiedAt: Date };
export const signupDomainReviewSchema = z.object({
  domain: z.string(),
  status: z.enum(['held_pending_review', 'blocked', 'released']),
  reason: z.string(),
  triggeredAt: z.date(),
  cohortUserIds: z.array(z.string()),
  sampleEmails: z.array(z.string()),
  signupCount: z.number(),
});
export type SignupDomainReview = z.infer<typeof signupDomainReviewSchema>;

export type SignupProtectionRepository = {
  observe: (signup: SignupObservation) => Promise<void>;
  recent: (domain: string, since: Date) => Promise<SignupObservation[]>;
  findReview: (domain: string) => Promise<SignupDomainReview | null>;
  createHold: (review: SignupDomainReview) => Promise<boolean>;
  isOrganizationDomain: (email: string) => Promise<boolean>;
};

export type SignupProtection = {
  repository: SignupProtectionRepository;
  mode?: 'observe' | 'enforce';
  notifyHold?: (review: SignupDomainReview) => Promise<void>;
};

import {
  STRIPE_DISPUTE_STATES,
  STRIPE_DISPUTE_SUBJECTS,
  type StripeDisputeListQuery,
  type StripeDisputeState,
  type StripeDisputeSubject,
} from '@bike4mind/common';

// The page has no free-text search; query and view are declared only because the list URL state needs them.
export const STRIPE_DISPUTE_SEARCH_KEYS = {
  query: 'disputeQuery',
  view: 'disputeView',
  filters: { state: 'disputeState', subject: 'disputeSubject' },
} as const;
export const STRIPE_DISPUTE_TAB_PARAMS = Object.values(STRIPE_DISPUTE_SEARCH_KEYS.filters);

const isState = (value: string): value is StripeDisputeState =>
  (STRIPE_DISPUTE_STATES as readonly string[]).includes(value);
const isSubject = (value: string): value is StripeDisputeSubject =>
  (STRIPE_DISPUTE_SUBJECTS as readonly string[]).includes(value);

/** Reads the URL filters; an unset or unknown value means no filter, so it never reaches the API. */
export function readStripeDisputeFilters(filters: Record<string, string>): StripeDisputeListQuery {
  const state = filters.state ?? '';
  const subject = filters.subject ?? '';
  return {
    state: isState(state) ? state : undefined,
    subject: isSubject(subject) ? subject : undefined,
  };
}

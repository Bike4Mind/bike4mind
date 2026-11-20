import * as z from 'zod';
import type { IUserActivityCounterDocument } from '../types/entities/UserTypes';
import type { ICounterLogDocument } from '../types/entities/CounterLogTypes';
import { passthroughShape } from './responseShape';

// Held to the entity interface: a new field fails the build here until it is listed. Key
// boundary only - it strips keys it does not list, it never withholds one.
const USER_ACTIVITY_COUNTER_RESPONSE_FIELDS = {
  id: true,
  createdAt: true,
  updatedAt: true,
  userId: true,
  action: true,
  count: true,
  tags: true,
} as const satisfies Record<keyof IUserActivityCounterDocument, true>;

/** GET /api/users/[id]/activities. */
export const userActivityCounterListResponseSchema = z.array(
  z.object(passthroughShape(USER_ACTIVITY_COUNTER_RESPONSE_FIELDS))
);

const COUNTER_LOG_RESPONSE_FIELDS = {
  id: true,
  createdAt: true,
  updatedAt: true,
  userId: true,
  userName: true,
  userTags: true,
  userLevel: true,
  userOrganization: true,
  counterName: true,
  counterTags: true,
  counterValue: true,
  datetime: true,
  metadata: true,
} as const satisfies Record<keyof ICounterLogDocument, true>;

/** GET /api/users/activities/recent. */
export const recentActivityListResponseSchema = z.array(z.object(passthroughShape(COUNTER_LOG_RESPONSE_FIELDS)));

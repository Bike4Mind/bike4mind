import * as z from 'zod';
import type { IUserActivityCounterDocument } from '../types/entities/UserTypes';
import type { ICounterLogDocument } from '../types/entities/CounterLogTypes';
import { passthroughField, passthroughShape } from './responseShape';

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

// Kept on the audit row for auditors only: a keyed hash of text the user chose is never served back.
const AUDIT_ONLY_METADATA_KEYS = ['fileNameHash'];

const withoutAuditOnlyMetadata = (metadata: unknown): unknown => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return metadata;
  const visible: Record<string, unknown> = { ...(metadata as Record<string, unknown>) };
  for (const key of AUDIT_ONLY_METADATA_KEYS) delete visible[key];
  return visible;
};

/** GET /api/users/activities/recent. */
export const recentActivityListResponseSchema = z.array(
  z.object({
    ...passthroughShape(COUNTER_LOG_RESPONSE_FIELDS),
    metadata: passthroughField.transform(withoutAuditOnlyMetadata),
  })
);

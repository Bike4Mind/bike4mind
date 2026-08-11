/**
 * Shared validators for the `/api/work-items` CRUD endpoints. Bounds-check user
 * input before it reaches Mongoose so malformed requests yield a 400 instead of
 * leaking schema details via a 500. Kept in sync with WorkItemModel's maxlength
 * constraints - see packages/database/src/models/ai/WorkItemModel.ts.
 */

import { Types } from 'mongoose';
import { BadRequestError } from '@bike4mind/utils';
import { WORK_ITEM_STATUSES, type WorkItemStatus } from '@bike4mind/common';

const TITLE_MAX = 300;
const DESCRIPTION_MAX = 10_000;

/**
 * Shared across the four work-item routes. `/ready` and `/graph` each load the
 * caller's whole live backlog, and every write runs two graph loads for the
 * cycle check, so the endpoints do real work even though they are bounded by
 * the caller's own item count.
 */
export const WORK_ITEM_RATE_LIMIT = 120;
export const WORK_ITEM_RATE_WINDOW_MS = 60 * 1000;
/** Bounds the fan-in of a single item, and with it the cycle check's cost. */
const DEPENDENCIES_MAX = 50;

// Round-trip rather than mongoose.isValidObjectId, which also accepts any
// 12-character string. Matches the check in orgAccess.ts.
function isValidObjectId(id: string): boolean {
  return Types.ObjectId.isValid(id) && new Types.ObjectId(id).toString() === id;
}

export function validateWorkItemTitle(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestError('Work item title is required');
  }
  const title = value.trim();
  if (title.length > TITLE_MAX) {
    throw new BadRequestError(`Work item title must be ${TITLE_MAX} characters or fewer`);
  }
  return title;
}

/**
 * Returns `null` for `''`/explicit `null` - the repository's "clear this field"
 * signal - and `undefined` only when the caller did not mention the field.
 */
export function validateWorkItemDescription(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new BadRequestError('description must be a string');
  }
  if (value.length > DESCRIPTION_MAX) {
    throw new BadRequestError(`description must be ${DESCRIPTION_MAX} characters or fewer`);
  }
  return value;
}

// `''` is not a plausible "unset" signal for an enum, so it is rejected rather
// than ignored - a fail-quiet here would silently drop a status change.
export function validateWorkItemStatus(value: unknown): WorkItemStatus | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !WORK_ITEM_STATUSES.includes(value as WorkItemStatus)) {
    throw new BadRequestError(`status must be one of: ${WORK_ITEM_STATUSES.join(', ')}`);
  }
  return value as WorkItemStatus;
}

/** Parse a repeated or comma-separated `status` query param into a filter list. */
export function parseStatusFilter(value: unknown): WorkItemStatus[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const statuses = raw
    .map(entry => String(entry).trim())
    // Trailing/duplicated commas produce empty segments; drop them before
    // validating, since the enum itself rejects ''.
    .filter(entry => entry !== '')
    .map(entry => validateWorkItemStatus(entry))
    .filter((s): s is WorkItemStatus => !!s);
  return statuses.length > 0 ? statuses : undefined;
}

export function validateWorkItemDependencies(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new BadRequestError('dependencies must be an array of work item ids');
  }
  if (value.length > DEPENDENCIES_MAX) {
    throw new BadRequestError(`dependencies must contain ${DEPENDENCIES_MAX} ids or fewer`);
  }
  const ids = value.map(entry => {
    if (typeof entry !== 'string' || !isValidObjectId(entry)) {
      throw new BadRequestError(`dependencies contains an invalid work item id: ${String(entry)}`);
    }
    return entry;
  });
  return Array.from(new Set(ids));
}

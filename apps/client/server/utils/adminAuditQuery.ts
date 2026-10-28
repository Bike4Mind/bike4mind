import { z } from 'zod';
import {
  AuditLogFiltersSchema,
  USER_TIMELINE_TYPES,
  UserActivityDirectionSchema,
  UserTimelineTypeSchema,
  type AuditLogCursor,
  type AuditLogFilters,
  type UserActivityDirection,
  type UserTimelineType,
} from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';

const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

export const encodeAuditCursor = (cursor: AuditLogCursor): string =>
  Buffer.from(`${cursor.occurredAt.toISOString()}|${cursor.id}`, 'utf8').toString('base64url');

/** Opaque to callers; a tampered or malformed cursor returns null so the route fails closed with a 400. */
export const decodeAuditCursor = (encoded: string): AuditLogCursor | null => {
  const raw = Buffer.from(encoded, 'base64url').toString('utf8');
  const separatorIndex = raw.indexOf('|');
  if (separatorIndex === -1) return null;

  const occurredAt = new Date(raw.slice(0, separatorIndex));
  const id = raw.slice(separatorIndex + 1);
  if (Number.isNaN(occurredAt.getTime()) || !OBJECT_ID_PATTERN.test(id)) return null;

  return { occurredAt, id };
};

/** Rejects repeated params rather than silently taking the first; empty values count as absent. */
const readSingleValues = (query: unknown): Record<string, string> => {
  if (typeof query !== 'object' || query === null) return {};

  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) throw new BadRequestError(`Query parameter "${key}" must be given once`);
    if (typeof value === 'string' && value !== '') values[key] = value;
  }
  return values;
};

const parseFilters = (values: Record<string, string>): AuditLogFilters => {
  const result = AuditLogFiltersSchema.safeParse(values);
  if (!result.success) throw new BadRequestError(result.error.issues[0]?.message || 'Invalid query parameters');
  return result.data;
};

const parseLimit = (raw: string | undefined): number => {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (!/^-?\d+$/.test(raw)) throw new BadRequestError('limit must be an integer');
  return Math.min(Math.max(Number(raw), MIN_LIMIT), MAX_LIMIT);
};

const parseCursor = (raw: string | undefined): AuditLogCursor | undefined => {
  if (raw === undefined) return undefined;
  const cursor = decodeAuditCursor(raw);
  if (!cursor) throw new BadRequestError('Invalid cursor');
  return cursor;
};

export const parseAuditListQuery = (
  query: unknown
): { filters: AuditLogFilters; limit: number; cursor?: AuditLogCursor } => {
  const values = readSingleValues(query);
  return { filters: parseFilters(values), limit: parseLimit(values.limit), cursor: parseCursor(values.cursor) };
};

/** Export takes the same filters but ignores limit and cursor. */
export const parseAuditExportQuery = (query: unknown): AuditLogFilters => parseFilters(readSingleValues(query));

const parseBooleanFlag = (raw: string | undefined, name: string): boolean => {
  if (raw === undefined || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new BadRequestError(`${name} must be true or false`);
};

/** The per-user Activity query: direction defaults to `target`, security events are opt-in. */
export const parseUserActivityQuery = (
  query: unknown
): { direction: UserActivityDirection; includeSecurity: boolean; limit: number; cursor?: AuditLogCursor } => {
  const values = readSingleValues(query);
  const direction = UserActivityDirectionSchema.safeParse(values.direction ?? 'target');
  if (!direction.success) throw new BadRequestError('direction must be target or actor');
  return {
    direction: direction.data,
    includeSecurity: parseBooleanFlag(values.includeSecurity, 'includeSecurity'),
    limit: parseLimit(values.limit),
    cursor: parseCursor(values.cursor),
  };
};

/** A cursor-paged list with no filters (e.g. a user's sign-ins). */
export const parseCursorPageQuery = (query: unknown): { limit: number; cursor?: AuditLogCursor } => {
  const values = readSingleValues(query);
  return { limit: parseLimit(values.limit), cursor: parseCursor(values.cursor) };
};

const parseInstant = (raw: string | undefined, name: string): Date | undefined => {
  if (raw === undefined) return undefined;
  const result = z.iso.datetime({ offset: true }).safeParse(raw);
  if (!result.success) throw new BadRequestError(`${name} must be an ISO 8601 date-time`);
  return new Date(result.data);
};

const parseTimelineTypes = (raw: string | undefined): UserTimelineType[] => {
  if (raw === undefined) return [...USER_TIMELINE_TYPES];
  const result = z.array(UserTimelineTypeSchema).min(1).safeParse(raw.split(','));
  if (!result.success)
    throw new BadRequestError(`types must be a comma-separated list of ${USER_TIMELINE_TYPES.join(', ')}`);
  return [...new Set(result.data)];
};

/** The per-user timeline query: every source by default, an optional inclusive date range, keyset paging. */
export const parseUserTimelineQuery = (
  query: unknown
): { types: UserTimelineType[]; range: { from?: Date; to?: Date }; limit: number; cursor?: AuditLogCursor } => {
  const values = readSingleValues(query);
  const from = parseInstant(values.from, 'from');
  const to = parseInstant(values.to, 'to');
  if (from && to && from.getTime() > to.getTime()) throw new BadRequestError('from must not be after to');
  return {
    types: parseTimelineTypes(values.types),
    range: { from, to },
    limit: parseLimit(values.limit),
    cursor: parseCursor(values.cursor),
  };
};

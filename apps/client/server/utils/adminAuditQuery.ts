import { AuditLogFiltersSchema, type AuditLogCursor, type AuditLogFilters } from '@bike4mind/common';
import { BadRequestError } from '@server/utils/errors';

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

import { Types } from 'mongoose';
import { ApiKeyUsageLog } from '@bike4mind/database';
import { AdminApiRequestSchema, type AuditLogCursor, type UserTimelineApiRequestEntry } from '@bike4mind/common';

export type ApiRequestPageOptions = {
  limit: number;
  cursor?: AuditLogCursor;
  range: { from?: Date; to?: Date };
  apiKeyId?: string;
};

export type ApiRequestRow = {
  _id: Types.ObjectId;
  timestamp: Date;
  keyId: string;
  method: string;
  endpoint: string;
  statusCode: number;
  responseTime: number;
  ipAddress: string;
};

export const apiRequestFilter = (userId: string, page: ApiRequestPageOptions) => ({
  $and: [
    { userId, ...(page.apiKeyId ? { keyId: page.apiKeyId } : {}) },
    ...(page.range.from ? [{ timestamp: { $gte: page.range.from } }] : []),
    ...(page.range.to ? [{ timestamp: { $lte: page.range.to } }] : []),
    ...(page.cursor
      ? [
          {
            $or: [
              { timestamp: { $lt: page.cursor.occurredAt } },
              { timestamp: page.cursor.occurredAt, _id: { $lt: new Types.ObjectId(page.cursor.id) } },
            ],
          },
        ]
      : []),
  ],
});

export const readApiRequests = (userId: string, page: ApiRequestPageOptions): Promise<ApiRequestRow[]> =>
  ApiKeyUsageLog.find(apiRequestFilter(userId, page))
    .select('_id timestamp keyId method endpoint statusCode responseTime ipAddress')
    .sort({ timestamp: -1, _id: -1 })
    .limit(page.limit + 1)
    .maxTimeMS(15_000)
    .lean<ApiRequestRow[]>();

export function apiRequestToEntry(row: ApiRequestRow): UserTimelineApiRequestEntry {
  const request = AdminApiRequestSchema.parse({
    keyId: row.keyId,
    method: row.method,
    endpoint: row.endpoint.split(/[?#]/, 1)[0],
    statusCode: row.statusCode,
    responseTimeMs: row.responseTime,
    ip: row.ipAddress,
  });
  return {
    type: 'api_request',
    id: row._id.toString(),
    at: row.timestamp,
    summary: `${request.method} ${request.endpoint} - ${request.statusCode}`,
    detail: `${request.responseTimeMs} ms \u00b7 ${request.ip} \u00b7 Key ${request.keyId}`,
    alert: request.statusCode >= 400,
    request,
  };
}

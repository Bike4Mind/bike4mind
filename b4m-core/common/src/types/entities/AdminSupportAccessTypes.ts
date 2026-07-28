import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';
import { ISessionDocument } from './SessionTypes';

/**
 * What a support read actually touched. One value per admin support endpoint, so
 * the audit trail distinguishes "looked at the notebook's settings and
 * attachments" from "read the customer's prompts and the model's replies".
 */
export enum AdminSupportAccessAction {
  /** GET /api/admin/sessions/[id] - session doc plus attachment metadata. */
  SessionRead = 'session.read',
  /** GET /api/admin/sessions/[id]/quests - prompts and replies. */
  SessionQuestsRead = 'session.quests.read',
}

/**
 * One admin read of a customer's notebook, recorded before the content is
 * returned. This is customer content: the trail is the feature, so a failed
 * audit write fails the request rather than being swallowed.
 */
export interface IAdminSupportAccessAuditLog {
  action: AdminSupportAccessAction;
  /** Platform admin who performed the read. */
  actorUserId: string;
  /** Owner of the session that was read. */
  targetUserId: string;
  sessionId: string;
  /**
   * Support-case reference supplied by the caller (required by the endpoints),
   * so the log says *why* the read happened without a second system.
   */
  supportCase: string;
  /** Last (non-spoofable) hop of the X-Forwarded-For chain. */
  actorIp?: string;
  actorUserAgent?: string;
  /** Endpoint-specific context, e.g. the page of quests returned. */
  details?: Record<string, unknown>;
  createdAt: Date;
  /** TTL horizon - support reads are retained for two years. */
  expiresAt: Date;
}

export interface IAdminSupportAccessAuditLogDocument extends IAdminSupportAccessAuditLog, IMongoDocument {}

export interface IAdminSupportAccessAuditLogRepository extends IBaseRepository<IAdminSupportAccessAuditLogDocument> {
  /** Append one support-read event. Awaited by callers - never fire-and-forget. */
  record(
    event: Omit<IAdminSupportAccessAuditLog, 'createdAt' | 'expiresAt'>
  ): Promise<IAdminSupportAccessAuditLogDocument>;
}

/**
 * Attachment metadata for the support view. Deliberately metadata only - enough
 * to answer "was a file attached that this model could not read?" without
 * handing the file's contents to an admin.
 */
export interface IAdminSupportFileSummary {
  id: string;
  fileName: string;
  mimeType?: string;
  fileSize?: number;
  type?: string;
  status?: string;
  moderationStatus?: string;
  blockReason?: string;
  vectorized?: boolean;
  chunkCount?: number;
  vectorizedChunkCount?: number;
  error?: string | null;
  createdAt?: Date;
}

/** Wire shape of GET /api/admin/sessions/[id]. */
export interface IAdminSupportSessionResponse {
  /** `systemPromptText` is stripped - it is server-owned, not customer content. */
  session: Omit<ISessionDocument, 'systemPromptText'>;
  /** Files attached to the session via `knowledgeIds`. */
  knowledge: IAdminSupportFileSummary[];
  /** Files uploaded into the session (`fabFiles.sessionId`). */
  sessionFiles: IAdminSupportFileSummary[];
}

/** One turn of the conversation, as the support view renders it. */
export interface IAdminSupportQuest {
  id: string;
  timestamp?: Date;
  type?: string;
  status?: string;
  errorCode?: string;
  prompt: string;
  reply?: string | null;
  replies?: string[];
  fabFileIds?: string[];
  images?: string[];
  model?: string;
  creditsUsed?: number;
}

/** Wire shape of GET /api/admin/sessions/[id]/quests. */
export interface IAdminSupportQuestsResponse {
  sessionId: string;
  page: number;
  limit: number;
  hasMore: boolean;
  quests: IAdminSupportQuest[];
}

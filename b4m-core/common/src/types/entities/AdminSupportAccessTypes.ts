import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';
import { ChatModelName } from '../../models';
import { IConversationContext } from './SessionTypes';
import { Permission } from './ShareableDocumentTypes';

/**
 * What a support read actually touched. One value per admin support endpoint, so
 * the audit trail distinguishes "looked at the notebook's settings and
 * attachments" from "read the customer's conversation".
 *
 * The split is only meaningful if it is honest, so nothing derived from the
 * conversation - not even a summary of it - is served under `SessionRead`. See
 * {@link IAdminSupportSession}.
 */
export enum AdminSupportAccessAction {
  /** GET /api/admin/sessions/[id] - session config plus attachment metadata. */
  SessionRead = 'session.read',
  /**
   * GET /api/admin/sessions/[id]/quests - prompts, replies, and the
   * conversation-derived session fields (summaries, remembered entities).
   */
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
  /**
   * Actor IP as resolved by the shared `getClientIp` resolver, which prefers the
   * headers a CDN overwrites (`cloudfront-viewer-address`, `cf-connecting-ip`,
   * ...) over raw X-Forwarded-For - a caller-supplied value must not be able to
   * poison a two-year compliance record.
   */
  actorIp?: string;
  actorUserAgent?: string;
  /**
   * Set when the read was made with an API key rather than an interactive
   * browser session, so the trail can tell automation from a person.
   */
  actorApiKeyId?: string;
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
  /**
   * Set when a still-referenced attachment has since been deleted - the answer to
   * "the session lists this file, so where is it?".
   */
  deletedAt?: Date | null;
}

/**
 * The session as the support view sees it: an explicit WHITELIST of configuration
 * and diagnostic fields, never `Omit<ISession, ...>`.
 *
 * A denylist would auto-expose whatever is added to `SessionModel` next, and this
 * response is served under the `session.read` audit action - the one that records
 * "settings and attachments only". So conversation-derived fields are absent by
 * construction here and are served under the quests action instead: `summary`,
 * `contextSummary` (LLM summaries OF the conversation) and `conversationContext`
 * (remembered Jira/GitHub/Confluence titles). Their *metadata* - when a summary
 * was written, by which model - stays here, since that is diagnostics, not content.
 *
 * `systemPromptText` is absent too, for the opposite reason: it is server-owned
 * proprietary prompt text (see SERVER_OWNED_SESSION_FIELDS).
 */
export interface IAdminSupportSession {
  id: string;
  name: string;
  /** Owner - the user whose content this is. */
  userId: string;
  firstCreated?: Date;
  lastUpdated?: Date;
  createdAt?: Date;
  updatedAt?: Date;
  deletedAt?: Date;
  language?: string;
  surface?: string;
  messageCount?: number;

  // Model and generation configuration - the usual cause of a "bad session".
  lastUsedModel?: string | null;
  temperature?: number;
  maxToolCalls?: number;
  citationStyle?: 'named' | 'indexed';

  // What was attached / available to the model.
  knowledgeIds?: string[];
  artifactIds?: string[];
  toolIds?: string[];
  agentIds?: string[];
  enabledTools?: string[];
  disabledTools?: string[];
  disableUserIntegrations?: boolean;
  forceKnowledgeRetrieval?: boolean;
  retrievalTags?: string[];
  retrievalExcludeFilenameMarkers?: string[];
  retrievalVectorizedOnly?: boolean;

  // Provenance.
  clonedSourceId?: string | null;
  forkedSourceId?: string | null;
  isAutoNamed?: boolean;

  // Sharing state - answers "who else could see this?". Share entries carry ids
  // and permissions only; the `user` virtual is never populated, so no third
  // party's profile is joined in.
  isGlobalRead?: boolean;
  isGlobalWrite?: boolean;
  sharedWith?: { userId: string; permissions: Permission[]; projectId?: string }[];
  sharedWithGroups?: { groupId: string; permissions: Permission[] }[];

  // Summary METADATA only - the summary text is conversation content.
  hasSummary: boolean;
  summaryAt?: Date;
  summaryModelId?: ChatModelName;
  summaryTrigger?: string;
  hasContextSummary: boolean;
  contextSummaryAt?: Date;
  contextSummaryModelId?: ChatModelName;
  curatedNotebookFileId?: string;
  curatedAt?: Date;
}

/** Wire shape of GET /api/admin/sessions/[id]. */
export interface IAdminSupportSessionResponse {
  session: IAdminSupportSession;
  /** Files attached to the session via `knowledgeIds`. */
  knowledge: IAdminSupportFileSummary[];
  /** Files uploaded into the session (`fabFiles.sessionId`). */
  sessionFiles: IAdminSupportFileSummary[];
  /** True when `sessionFiles` hit the row cap and is not the whole list. */
  sessionFilesTruncated: boolean;
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

/**
 * Session fields that are derived from the conversation rather than configured:
 * LLM-written summaries of it, and the entities it remembered (Jira/GitHub/
 * Confluence keys and titles). They live on the session document, but disclosing
 * them is a content read, so they are served here - under the action the audit
 * trail records as a content read - and not by GET /api/admin/sessions/[id].
 */
export interface IAdminSupportConversationContext {
  summary?: string;
  contextSummary?: string;
  conversationContext?: IConversationContext;
}

/** Wire shape of GET /api/admin/sessions/[id]/quests. */
export interface IAdminSupportQuestsResponse {
  sessionId: string;
  page: number;
  limit: number;
  hasMore: boolean;
  quests: IAdminSupportQuest[];
  sessionContext: IAdminSupportConversationContext;
}

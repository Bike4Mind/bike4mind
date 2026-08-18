import { baseApi } from '@server/middlewares/baseApi';
import { fabFileRepository } from '@bike4mind/database';
import {
  AdminSupportAccessAction,
  IAdminSupportFileSummary,
  IAdminSupportSession,
  IAdminSupportSessionResponse,
  IFabFileDocument,
  ISessionDocument,
} from '@bike4mind/common';
import { authorizeSupportRead, recordSupportRead } from '@server/utils/adminSupportAccess';

/**
 * Read-only support view of one customer notebook: its configuration plus metadata
 * for everything attached to it. Answers the question the billing view can't -
 * "what was this notebook configured with, and what files were attached?" - which
 * is how you spot e.g. a document attached to a model with `supportsVision: false`.
 *
 * Access: platform admin only, `supportCase` required, every read audited. See
 * `@server/utils/adminSupportAccess` for the shared gate.
 *
 * Two disclosure rules, both enforced by whitelisting rather than stripping:
 *
 * - Attachments are metadata only. No file contents, and no signed or stored URLs,
 *   so an admin diagnosing a notebook never pulls the customer's documents.
 * - Nothing derived from the conversation is served here, not even a summary of
 *   it. This response is audited as `session.read` ("settings and attachments"),
 *   and that record is only honest if it is true - so `summary`,
 *   `contextSummary` and `conversationContext` are served by the quests route
 *   instead, under the action that records a content read.
 *
 * GET /api/admin/sessions/[id]?supportCase=<ref>
 */

const toFileSummary = (file: IFabFileDocument): IAdminSupportFileSummary => ({
  id: file.id,
  fileName: file.fileName,
  mimeType: file.mimeType,
  fileSize: file.fileSize,
  type: file.type,
  status: file.status,
  moderationStatus: file.moderationStatus,
  blockReason: file.blockReason,
  vectorized: file.vectorized,
  chunkCount: file.chunkCount,
  vectorizedChunkCount: file.vectorizedChunkCount,
  error: file.error,
  createdAt: file.createdAt,
  deletedAt: file.deletedAt,
});

/**
 * Closed whitelist - never a spread or an `Omit`. A field added to `SessionModel`
 * later must be opted in here deliberately, not inherited into a support view.
 */
const toSupportSession = (session: ISessionDocument): IAdminSupportSession => ({
  id: session.id,
  name: session.name,
  userId: session.userId,
  firstCreated: session.firstCreated,
  lastUpdated: session.lastUpdated,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  deletedAt: session.deletedAt,
  language: session.language,
  surface: session.surface,
  messageCount: session.messageCount,

  lastUsedModel: session.lastUsedModel,
  temperature: session.temperature,
  maxToolCalls: session.maxToolCalls,
  citationStyle: session.citationStyle,

  knowledgeIds: session.knowledgeIds,
  artifactIds: session.artifactIds,
  toolIds: session.toolIds,
  agentIds: session.agentIds,
  enabledTools: session.enabledTools,
  disabledTools: session.disabledTools,
  disableUserIntegrations: session.disableUserIntegrations,
  forceKnowledgeRetrieval: session.forceKnowledgeRetrieval,
  retrievalTags: session.retrievalTags,
  retrievalExcludeFilenameMarkers: session.retrievalExcludeFilenameMarkers,
  retrievalVectorizedOnly: session.retrievalVectorizedOnly,

  clonedSourceId: session.clonedSourceId,
  forkedSourceId: session.forkedSourceId,
  isAutoNamed: session.isAutoNamed,

  isGlobalRead: session.isGlobalRead,
  isGlobalWrite: session.isGlobalWrite,
  // Ids and permissions only - the `user` virtual is not populated by findById,
  // so no third party's profile is joined into a support response.
  sharedWith: session.users?.map(share => ({
    userId: share.userId,
    permissions: share.permissions,
    projectId: share.projectId,
  })),
  sharedWithGroups: session.groups?.map(share => ({
    groupId: share.groupId,
    permissions: share.permissions,
  })),

  // Presence and provenance of the summaries, never their text.
  hasSummary: Boolean(session.summary),
  summaryAt: session.summaryAt,
  summaryModelId: session.summaryModelId,
  summaryTrigger: session.summaryTrigger,
  hasContextSummary: Boolean(session.contextSummary),
  contextSummaryAt: session.contextSummaryAt,
  contextSummaryModelId: session.contextSummaryModelId,
  curatedNotebookFileId: session.curatedNotebookFileId,
  curatedAt: session.curatedAt,
});

const handler = baseApi().get(async (req, res) => {
  const ctx = await authorizeSupportRead(req);

  const knowledgeIds = ctx.session.knowledgeIds ?? [];
  const [knowledge, sessionFiles] = await Promise.all([
    fabFileRepository.findMetadataByIds(knowledgeIds),
    fabFileRepository.findMetadataBySessionId(ctx.session.id),
  ]);

  // Awaited before responding: an unauditable support read is not served.
  await recordSupportRead(ctx, AdminSupportAccessAction.SessionRead, {
    knowledgeIdCount: knowledgeIds.length,
    knowledgeFound: knowledge.data.length,
    knowledgeTruncated: knowledge.hasMore,
    sessionFileCount: sessionFiles.data.length,
    sessionFilesTruncated: sessionFiles.hasMore,
  });

  const response: IAdminSupportSessionResponse = {
    session: toSupportSession(ctx.session),
    knowledge: knowledge.data.map(toFileSummary),
    knowledgeTruncated: knowledge.hasMore,
    sessionFiles: sessionFiles.data.map(toFileSummary),
    sessionFilesTruncated: sessionFiles.hasMore,
  };
  return res.json(response);
});

export default handler;

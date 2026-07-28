import { baseApi } from '@server/middlewares/baseApi';
import { fabFileRepository } from '@bike4mind/database';
import {
  AdminSupportAccessAction,
  IAdminSupportFileSummary,
  IAdminSupportSessionResponse,
  IFabFileDocument,
  redactSessionForClient,
} from '@bike4mind/common';
import { authorizeSupportRead, recordSupportRead } from '@server/utils/adminSupportAccess';

/**
 * Read-only support view of one customer notebook: the session doc plus metadata
 * for everything attached to it. Answers the question the billing view can't -
 * "what was this notebook configured with, and what files were attached?" - which
 * is how you spot e.g. a document attached to a model with `supportsVision: false`.
 *
 * Access: platform admin only, `supportCase` required, every read audited. See
 * `@server/utils/adminSupportAccess` for the shared gate. Metadata only: no file
 * contents and no signed URLs, so an admin diagnosing a notebook never pulls the
 * customer's documents down.
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
    knowledgeFound: knowledge.length,
    sessionFileCount: sessionFiles.length,
  });

  const response: IAdminSupportSessionResponse = {
    session: redactSessionForClient(ctx.session),
    knowledge: (knowledge as IFabFileDocument[]).map(toFileSummary),
    sessionFiles: (sessionFiles as IFabFileDocument[]).map(toFileSummary),
  };
  return res.json(response);
});

export default handler;

import { KnowledgeType } from '@bike4mind/common';
import { createFabFile } from '../../../fabFileService/create';
import type { ToolContext } from '../base/types';

/**
 * Persist a tool-generated file (image, Excel, etc.) as a session-scoped FabFile so it
 * shows up in the Knowledge Base / WorkBench and is downloadable after the run.
 *
 * Why this exists: file-generating tools historically only pushed the generated filename
 * into `quest.images` via `statusUpdate`, which (a) renders fine inline for images but is
 * a broken `<img>` for non-image files like .xlsx, and (b) was never recorded as a FabFile,
 * so nothing the user can browse referenced it - the file was effectively orphaned in the
 * generated-content bucket (observed in prod: agent-generated images lost entirely).
 * Creating a FabFile with `sessionId` set makes the file appear in the Knowledge Viewer
 * via `useGetFabFilesBySessionId` -> `useMessageFiles`.
 *
 * Best-effort: a failure here (missing adapters, storage quota, unsupported mime) must never
 * break the tool itself - the inline `quest.images` render still works. We log and swallow.
 *
 * The file is re-uploaded into the FabFile bucket (`context.storage`) because the Knowledge
 * Viewer reads FabFiles through their signed `fileUrl`, which is issued against that bucket.
 */
export async function persistGeneratedFileAsFabFile(
  context: ToolContext,
  file: { fileName: string; mimeType: string; content: Buffer }
): Promise<void> {
  const { sessionId, userId, db, storage, logger } = context;

  // No session means nothing to attach the file to (e.g. some non-chat tool harnesses).
  if (!sessionId) return;
  if (!db.fabfiles || !db.users || !db.adminSettings) {
    logger.warn('[persistGeneratedFileAsFabFile] missing db adapters — skipping FabFile persist');
    return;
  }

  try {
    await createFabFile(
      userId,
      {
        fileName: file.fileName,
        mimeType: file.mimeType,
        fileSize: file.content.length,
        type: KnowledgeType.FILE,
        content: file.content,
        contentType: file.mimeType,
        sessionId,
        prefix: 'generated',
        tags: [{ name: 'generated', strength: 1 }],
      },
      {
        db: {
          fabFiles: db.fabfiles,
          adminSettings: db.adminSettings,
          users: db.users,
        },
        storage: {
          upload: (path, content, options) => storage.upload(content, path, options),
          generateSignedUrl: (path, expireInSeconds, type) =>
            storage.getSignedUrl(path, type ?? 'get', { expiresIn: expireInSeconds }),
        },
      }
    );
  } catch (err) {
    logger.error('[persistGeneratedFileAsFabFile] failed to persist generated file (non-fatal)', err);
  }
}

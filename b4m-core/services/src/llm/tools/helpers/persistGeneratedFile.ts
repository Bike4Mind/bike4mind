import { FabFileSourceType, KnowledgeType, type GeneratedAssetMetadata } from '@bike4mind/common';
import { createFabFile } from '../../../fabFileService/create';
import {
  saveGeneratedAsset,
  type SaveGeneratedAssetDeps,
  type SaveGeneratedAssetResult,
} from '../../../generatedAssets';
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
 *
 * The session link lives in provenance (`sourceType: TOOL_GENERATED`, `sourceMetadata.sessionId`),
 * NOT the top-level `sessionId`. That field means "notebook summary file": the File Browser search
 * (fabFileSearchQuery.ts) hides every row carrying it, project context feeds every such row to the
 * LLM as a sibling-notebook summary (ChatCompletionFeatures.getProjectNotebookSummaries), and the
 * summarizer overwrites the first one it finds with the summary text (sessionSummarization.ts).
 * listFabFilesBySession reads the provenance link for the notebook's file view.
 *
 * Best-effort: a failure here (missing adapters, storage quota, unsupported mime) must never
 * break the tool itself - the inline `quest.images` render still works. We log and swallow.
 *
 * The file is re-uploaded into the FabFile bucket (`context.storage`) because the Knowledge
 * Viewer reads FabFiles through their signed `fileUrl`, which is issued against that bucket.
 */
export async function persistGeneratedFileAsFabFile(
  context: ToolContext,
  file: {
    fileName: string;
    mimeType: string;
    content: Buffer;
    /** KnowledgeType to store under; defaults to FILE. Audio-generating tools pass AUDIO. */
    type?: KnowledgeType;
    /** FabFile tags; defaults to a single `generated` tag. */
    tags?: { name: string; strength: number }[];
  }
): Promise<void> {
  const { sessionId, questId, userId, logger } = context;

  // Unlike saveGeneratedAssetFromTool, no session means no save: these tools already render the output inline
  // through quest.images, so the FabFile only exists to link it to its notebook.
  if (!sessionId) return;
  const adapters = toolFileAdapters(context);
  if (!adapters) {
    logger.warn('[persistGeneratedFileAsFabFile] missing db adapters - skipping FabFile persist');
    return;
  }

  try {
    await createFabFile(
      userId,
      {
        fileName: file.fileName,
        mimeType: file.mimeType,
        fileSize: file.content.length,
        type: file.type ?? KnowledgeType.FILE,
        content: file.content,
        contentType: file.mimeType,
        prefix: 'generated',
        tags: file.tags ?? [{ name: 'generated', strength: 1 }],
      },
      {
        ...adapters,
        provenance: {
          sourceType: FabFileSourceType.TOOL_GENERATED,
          sourceMetadata: { sessionId, ...(questId && { questId }) },
        },
      }
    );
  } catch (err) {
    logger.error('[persistGeneratedFileAsFabFile] failed to persist generated file (non-fatal)', err);
  }
}

/**
 * saveGeneratedAsset for an in-chat tool: the ToolContext supplies the adapters and the notebook link. Missing
 * adapters (some non-chat harnesses) skip the save rather than fail the tool.
 */
export async function saveGeneratedAssetFromTool(
  context: ToolContext,
  asset: { bytes: Buffer; contentType: string; generation: GeneratedAssetMetadata }
): Promise<SaveGeneratedAssetResult> {
  const { sessionId, questId, userId, logger } = context;
  const adapters = toolFileAdapters(context);
  if (!adapters) {
    logger.warn('[saveGeneratedAssetFromTool] missing db adapters - skipping save');
    return { saved: false, reason: 'error' };
  }

  return saveGeneratedAsset({ userId, ...asset, sessionId, questId }, { ...adapters, logger });
}

/**
 * The FabFile adapters a ToolContext supplies, or undefined when the harness lacks any of them. Mirrors the server
 * door (apps/client/server/utils/saveGeneratedAssetToFiles.ts): scopedSettings must ride along, or a per-org/owner/lake
 * enforcement override silently would not apply to tool output.
 */
function toolFileAdapters(context: ToolContext): Pick<SaveGeneratedAssetDeps, 'db' | 'storage'> | undefined {
  const { db, storage } = context;
  if (!db.fabfiles || !db.users || !db.adminSettings || !db.dataLakes) return undefined;
  return {
    db: {
      fabFiles: db.fabfiles,
      adminSettings: db.adminSettings,
      users: db.users,
      dataLakes: db.dataLakes,
      ...(db.scopedSettings && { scopedSettings: db.scopedSettings }),
    },
    storage: {
      upload: (path, content, options) => storage.upload(content, path, options),
      generateSignedUrl: (path, expireInSeconds, type) =>
        storage.getSignedUrl(path, type ?? 'get', { expiresIn: expireInSeconds }),
    },
  };
}

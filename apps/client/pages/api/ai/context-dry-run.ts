import { adminSettingsRepository } from '@bike4mind/database/infra';
import { fabFileRepository } from '@bike4mind/database/content';
import { userRepository } from '@bike4mind/database/auth';
import { fabFilesService } from '@bike4mind/services';
import {
  attachedContentAssemblyFloor,
  attachedContentExtractionBudget,
  getFileContent,
  safeInputWindow,
} from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { getFilesStorage } from '@server/utils/storage';
import { Request } from 'express';

/**
 * Would the files attached to this turn actually reach the model?
 *
 * Answers the question the composer cannot: the client knows a model's context window and its own
 * attachments, but not how much of a file survives extraction, and `fileSize` does not predict that for
 * anything but plain text. Without this the only honest pre-send warning would be a guess, and a
 * warning that fires on files which do fit is worse than none.
 *
 * Deliberately does NOT run the completion's feature pipeline. Assembling the real system stack would
 * need a quest, a tokenizer and status callbacks, and it fires side effects a question must never
 * cause: the mementos feature writes durable user memory and context summarization writes
 * `session.contextSummary`, both of which would then shape later real completions. Skipping the
 * pipeline avoids that structurally rather than by remembering to pass a flag. The consequence is that
 * the figures here account for the extraction stage only, which is the stage that binds on a small
 * window; a heavy system stack can still cost a file more at assembly.
 */

/** Mirrors CHARS_PER_TOKEN in the extraction path, so both sides estimate the same way. */
const CHARS_PER_TOKEN = 3.5;

/**
 * The model's dimensions come from the caller, which is the same `/api/models` payload the picker
 * itself renders, and are clamped here. They are safe to accept because nothing but a warning shown to
 * this caller depends on them: file access is authorized separately through the ability-scoped read
 * below, and no spend, entitlement or persistence decision reads these numbers. Resolving them
 * server-side instead would mean a multi-backend provider fan-out on every attachment change.
 */
const MAX_PLAUSIBLE_CONTEXT = 10_000_000;
const clampPositive = (value: unknown, fallback: number): number => {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : NaN;
  if (!(n > 0)) return fallback;
  return Math.min(n, MAX_PLAUSIBLE_CONTEXT);
};

interface DryRunBody {
  contextWindow?: number;
  maxOutputTokens?: number;
  requestedMaxTokens?: number;
  fileIds?: string[];
  /** Present for text models only; a media model reserves no output. */
  modelType?: string;
}

const handler = baseApi().post(async (req: Request<{}, {}, DryRunBody>, res) => {
  const body = req.body ?? {};
  const fileIds = Array.isArray(body.fileIds) ? body.fileIds.filter(id => typeof id === 'string') : [];
  const contextWindow = clampPositive(body.contextWindow, 0);

  // A window we cannot size tells us nothing, and guessing one would produce a confident wrong answer.
  if (!contextWindow) {
    return res.status(400).json({ error: 'contextWindow is required and must be a positive number' });
  }

  const maxOutputTokens = clampPositive(body.maxOutputTokens, 0);
  const requestedMaxTokens = clampPositive(body.requestedMaxTokens, maxOutputTokens);
  const modelInfo = {
    contextWindow,
    max_tokens: maxOutputTokens || undefined,
    type: body.modelType,
  } as Parameters<typeof safeInputWindow>[0];

  const maxSafeInputTokens = safeInputWindow(modelInfo, requestedMaxTokens);
  // Matches SYSTEM_PROMPT_RESERVE in ChatCompletionProcess: the flat allowance the extraction stage
  // sets aside for instructions. Bounded inside the helper, so a small window is not swallowed by it.
  const SYSTEM_PROMPT_RESERVE = 4000;
  const extractionBudget = attachedContentExtractionBudget(maxSafeInputTokens, SYSTEM_PROMPT_RESERVE);
  const assemblyFloor = attachedContentAssemblyFloor(maxSafeInputTokens);

  if (fileIds.length === 0) {
    return res.json({ maxSafeInputTokens, extractionBudget, assemblyFloor, perFileBudgetTokens: 0, files: [] });
  }

  const storage = getFilesStorage();
  const deps = {
    db: { fabFiles: fabFileRepository, users: userRepository, adminSettings: adminSettingsRepository },
    storage: {
      generateSignedUrl: async (path: string, expireInSeconds: number) =>
        storage.getSignedUrl(path, 'get', { expiresIn: expireInSeconds }),
    },
  };

  // Ability-scoped, exactly as /api/files/byIds reads: an id the caller cannot see must not be
  // measurable here either, or this route becomes a way to probe someone else's files.
  const accessible = await fabFilesService.listFabFiles(req.user, { ids: fileIds }, deps);
  const accessibleFiles = Array.isArray(accessible) ? accessible : ((accessible as { data?: unknown[] })?.data ?? []);

  // The extraction stage divides its budget by the number of text files on the turn, so a file's share
  // depends on how many siblings it has. Images are excluded there and so are excluded here.
  const textFiles = (accessibleFiles as { mimeType?: string }[]).filter(
    f => !String(f.mimeType ?? '').startsWith('image')
  );
  const perFileBudgetTokens = Math.max(1, Math.floor(extractionBudget / Math.max(1, textFiles.length)));
  const perFileBudgetChars = perFileBudgetTokens * CHARS_PER_TOKEN;

  const files = [];
  for (const file of accessibleFiles as {
    id?: string;
    _id?: string;
    fileName?: string;
    mimeType?: string;
    filePath?: string;
    fileSize?: number;
    extractedCharCount?: number;
  }[]) {
    const id = String(file.id ?? file._id ?? '');
    const isImage = String(file.mimeType ?? '').startsWith('image');
    let chars = typeof file.extractedCharCount === 'number' ? file.extractedCharCount : undefined;
    let measured: 'extracted' | 'fileSize' = chars === undefined ? 'fileSize' : 'extracted';

    if (chars === undefined && !isImage && file.filePath) {
      try {
        const content = await getFileContent(
          { mimeType: file.mimeType ?? '', fileName: file.fileName ?? '', filePath: file.filePath },
          { storage, logger: req.logger }
        );
        chars = content.length;
        measured = 'extracted';
        // Write-through so the next question about this file costs no download. Best-effort: a failed
        // cache write must not fail the answer, which is still correct without it.
        await fabFileRepository.update({ id, extractedCharCount: chars }).catch(() => {});
      } catch (error) {
        req.logger?.warn(`[context-dry-run] could not extract ${file.fileName ?? id}; falling back to fileSize`, error);
      }
    }

    // fileSize is a poor proxy for anything but text, so say which figure was used and let the client
    // decide how loudly to speak.
    const effectiveChars = chars ?? file.fileSize ?? 0;
    const estimatedTokens = Math.ceil(effectiveChars / CHARS_PER_TOKEN);
    files.push({
      id,
      fileName: file.fileName ?? '',
      isImage,
      extractedChars: chars,
      estimatedTokens,
      measured,
      // 1 means the whole file survives extraction. Images bypass the text budget entirely.
      deliveredFraction: isImage || effectiveChars === 0 ? 1 : Math.min(1, perFileBudgetChars / effectiveChars),
    });
  }

  return res.json({
    maxSafeInputTokens,
    extractionBudget,
    assemblyFloor,
    perFileBudgetTokens,
    textFileCount: textFiles.length,
    files,
  });
});

export default handler;

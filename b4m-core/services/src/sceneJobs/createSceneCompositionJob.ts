import {
  SCENE_INPUT_MEDIA,
  SCENE_MAX_INPUT_BYTES,
  SceneCompositionRequestSchema,
  toStoredSceneCompositionRequest,
  type SceneInputSlot,
  type StoredSceneCompositionRequest,
} from '@bike4mind/common';
import { findIdempotentReplay, persistAndEnqueueJob, resolveJobOwner } from '../generationJobs/createJob';
import {
  SCENE_JOB_MAX_WALL_CLOCK_MS,
  type CreateSceneCompositionJobDeps,
  type CreateSceneCompositionJobInput,
  type CreateSceneCompositionJobResult,
  type SceneInputFile,
} from './types';

/** The request's input files by slot, in render order. */
export const sceneInputSlots = (request: StoredSceneCompositionRequest): { slot: SceneInputSlot; fileId: string }[] => [
  { slot: 'video', fileId: request.videoFileId },
  { slot: 'audio', fileId: request.audioFileId },
  ...(request.coverFileId ? [{ slot: 'cover' as const, fileId: request.coverFileId }] : []),
];

/** The stored mime type without parameters, lowercased; the slot check keys off its leading part. */
export const isSceneSlotMedia = (slot: SceneInputSlot, file: SceneInputFile): boolean =>
  file.mimeType.split(';')[0].trim().toLowerCase().startsWith(SCENE_INPUT_MEDIA[slot]);

/**
 * Validates the request and its input files, then persists + enqueues a pending compose job. A Scene is rendered by
 * our own worker and holds no credits in v1 (the job's creditHold is null); the requester's account standing is
 * checked by the route and again by the engine before the render. Expected refusals are returned as values; a
 * failure to persist or enqueue throws (a 5xx for the caller).
 */
export async function createSceneCompositionJob(
  input: CreateSceneCompositionJobInput,
  deps: CreateSceneCompositionJobDeps
): Promise<CreateSceneCompositionJobResult> {
  const parsed = SceneCompositionRequestSchema.safeParse(input.request);
  if (!parsed.success) {
    const message = parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    return { ok: false, status: 422, code: 'invalid_request', message };
  }
  const request = toStoredSceneCompositionRequest(parsed.data);

  const owner = resolveJobOwner(input.user);
  const replay = await findIdempotentReplay(
    { kind: 'compose', owner, idempotencyKey: input.idempotencyKey, request },
    deps
  );
  if (replay) return replay;

  // Fails fast on someone else's (or a missing) file; the worker loads them again before the render.
  let inputBytes = 0;
  for (const { slot, fileId } of sceneInputSlots(request)) {
    const file = await deps.loadInputFile(input.user.id, fileId);
    if (!file) {
      return { ok: false, status: 404, code: 'input_file_not_found', message: `Input file not found (${slot})`, slot };
    }
    if (!isSceneSlotMedia(slot, file)) {
      return {
        ok: false,
        status: 422,
        code: 'unsupported_input',
        message: `The ${slot} file must be ${SCENE_INPUT_MEDIA[slot].slice(0, -1)} media, not ${file.mimeType}`,
      };
    }
    inputBytes += file.bytes;
  }
  if (inputBytes > SCENE_MAX_INPUT_BYTES) {
    return {
      ok: false,
      status: 422,
      code: 'limit_exceeded',
      message: `The input files total ${inputBytes} bytes; the limit is ${SCENE_MAX_INPUT_BYTES}`,
    };
  }

  // The Scene copies the video stream and re-encodes a soundtrack no longer than the video, so its inputs bound it.
  const storage = await deps.checkStorageFor(input.user.id, inputBytes);
  if (storage) {
    return {
      ok: false,
      status: 400,
      code: 'storage_quota_exceeded',
      message: 'Not enough free file storage for this Scene',
      storage,
    };
  }

  const now = deps.now();
  return persistAndEnqueueJob(
    'compose',
    {
      ...owner,
      requestedBy: input.user.id,
      ...(input.apiKeyId && { apiKeyId: input.apiKeyId }),
      source: input.source,
      state: 'pending',
      payload: { request },
      pollCount: 0,
      attempts: 0,
      cancelRequested: false,
      // Set at creation so the sweeper also recovers a job whose first queue message was lost.
      nextPollAt: now,
      deadlineAt: new Date(now.getTime() + SCENE_JOB_MAX_WALL_CLOCK_MS),
      idempotencyKey: input.idempotencyKey,
      // Free in v1: composing is our own cheap compute, not a billed provider call.
      creditHold: null,
    },
    deps
  );
}

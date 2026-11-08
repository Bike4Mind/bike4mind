import { Types } from 'mongoose';
import {
  getImageModelCatalogEntry,
  ImageJobRequestSchema,
  imageJobInputs,
  usdToCredits,
  validateImageRequest,
  type ImageJobRequest,
  type ImageModelCatalogEntry,
  type StoredImageRequest,
} from '@bike4mind/common';
import { releaseCreditHold, type CreditHold } from '../creditService/creditHold';
import { isUsableApiKey } from '../generationJobs/apiKey';
import {
  findIdempotentReplay,
  holdJobCredits,
  persistAndEnqueueJob,
  resolveJobOwner,
  type IdempotencyKeyReused,
  type JobOwner,
} from '../generationJobs/createJob';
import { resolveBilledImageQuality } from '../imageCost';
import { estimateImageJobUsd } from './imageJobCost';
import {
  IMAGE_JOB_BATCH_MAX,
  IMAGE_JOB_MAX_WALL_CLOCK_MS,
  IMAGE_JOB_OUTPUT_BYTES_ESTIMATE,
  type CreateImageJobsDeps,
  type CreateImageJobsInput,
  type CreateImageJobsResult,
  type ImageJob,
} from './types';

const FEATURE_LABEL = 'image generation';

type Refusal = Extract<CreateImageJobsResult, { ok: false }>;

const refuse = (
  status: 400 | 402 | 422,
  code: Exclude<Refusal['code'], 'storage_quota_exceeded' | 'unsupported_by_model'>,
  message: string
): Refusal => ({ ok: false, status, code, message });

/**
 * Checks the request against the model's capabilities and reports every reason it cannot be honoured. One job
 * renders one image, so it is checked at a count of 1 whatever the batch size.
 */
const checkAgainstModel = (request: ImageJobRequest, caps: ImageModelCatalogEntry): Refusal | null => {
  const validation = validateImageRequest({ ...request, count: 1 }, caps);
  if (validation.ok) return null;
  return {
    ok: false,
    status: 422,
    code: 'unsupported_by_model',
    message: validation.failures[0].reason,
    failures: validation.failures,
  };
};

/** The quality pinned to the tier it is billed and rendered at, so the hold and the render cannot disagree. */
const toStoredRequest = (request: ImageJobRequest): StoredImageRequest => {
  const quality = resolveBilledImageQuality(request.model, request.quality);
  return { ...request, ...(quality !== undefined && { quality }) };
};

const jobKey = (idempotencyKey: string | undefined, index: number) =>
  idempotencyKey === undefined ? undefined : `${idempotencyKey}:${index}`;

/**
 * Creates `count` image jobs that share a groupId ("make N"). Each job holds its own credits, so each settles on
 * delivery or is refunded on failure independently. Holds are taken for the whole batch before any job is
 * persisted, so an insufficient balance refuses the batch rather than starting part of it.
 */
export async function createImageJobs(
  input: CreateImageJobsInput,
  deps: CreateImageJobsDeps
): Promise<CreateImageJobsResult> {
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > IMAGE_JOB_BATCH_MAX) {
    return refuse(400, 'invalid_count', `count must be a whole number from 1 to ${IMAGE_JOB_BATCH_MAX}`);
  }
  const parsed = ImageJobRequestSchema.safeParse(input.request);
  if (!parsed.success) return refuse(400, 'invalid_request', parsed.error.issues[0]?.message ?? 'Invalid request');

  const caps = getImageModelCatalogEntry(parsed.data.model);
  if (!deps.providers.get(caps.provider)) {
    return refuse(422, 'model_unavailable', `Image model ${parsed.data.model} is not available for generation jobs`);
  }
  const unsupported = checkAgainstModel(parsed.data, caps);
  if (unsupported) return unsupported;
  const request = toStoredRequest(parsed.data);
  // The pin must itself be a tier the model takes; a catalog that disagrees with the pin is a bug, not user error.
  const pinnedUnsupported = checkAgainstModel(request, caps);
  if (pinnedUnsupported) return pinnedUnsupported;

  const owner = resolveJobOwner(input.user);
  const keys = Array.from({ length: input.count }, (_, index) => jobKey(input.idempotencyKey, index));
  const replays = await Promise.all(
    keys.map(idempotencyKey => findIdempotentReplay({ kind: 'image', owner, idempotencyKey, request }, deps))
  );
  const reused = replays.find((replay): replay is IdempotencyKeyReused => replay !== null && !replay.ok);
  if (reused) return reused;
  const replayed = replays.flatMap(replay => (replay?.ok ? [replay.job] : []));
  if (replayed.length === input.count) {
    return { ok: true, groupId: replayed[0].payload.groupId ?? replayed[0].id, jobs: replayed, created: false };
  }

  await deps.assertModelAdmission(input.user.id, request.model, input.user.adminRoleWithheld);
  if (!isUsableApiKey(await deps.resolveApiKey(caps.provider, input.user.id))) {
    return refuse(422, 'model_unavailable', `Image model ${request.model} has no API key configured`);
  }
  for (const imageInput of imageJobInputs(request)) {
    // Checked up front so a missing input refuses the request instead of failing every job after its hold.
    if (!(await deps.loadInputFile(input.user.id, imageInput.fileId))) {
      return refuse(422, 'input_image_not_found', `Input image not found (${imageInput.role})`);
    }
  }
  const missingIndexes = keys.flatMap((_, index) => (replays[index]?.ok ? [] : [index]));
  const storage = await deps.checkStorageFor(input.user.id, missingIndexes.length * IMAGE_JOB_OUTPUT_BYTES_ESTIMATE);
  if (storage) {
    return { ok: false, status: 400, code: 'storage_quota_exceeded', message: 'Storage quota exceeded', storage };
  }

  const { enforceCredits } = await deps.getSettings();
  const requiredCredits = usdToCredits(estimateImageJobUsd(request));
  const holds = await holdBatch(missingIndexes.length, { enforceCredits, user: input.user, requiredCredits }, deps);
  if (!holds.ok) return holds;

  const groupId = replayed[0]?.payload.groupId ?? new Types.ObjectId().toHexString();
  const created = await persistBatch(
    { owner, input, request, providerId: caps.provider, groupId, holds: holds.holds, keys, missingIndexes },
    deps
  );
  if (!created.ok) return created;
  // Back in request order: replays where a job already held the key, fresh jobs (in index order) elsewhere.
  const fresh = created.jobs[Symbol.iterator]();
  const jobs = replays.flatMap(replay => {
    const job = replay?.ok ? replay.job : fresh.next().value;
    return job ? [job] : [];
  });
  return { ok: true, groupId, jobs, created: true };
}

type HoldParams = { enforceCredits: boolean; user: CreateImageJobsInput['user']; requiredCredits: number };

async function holdBatch(
  count: number,
  params: HoldParams,
  deps: CreateImageJobsDeps
): Promise<{ ok: true; holds: (CreditHold | null)[] } | Refusal> {
  const holds: (CreditHold | null)[] = [];
  for (let index = 0; index < count; index++) {
    const held = await holdJobCredits({ ...params, featureLabel: FEATURE_LABEL }, deps);
    if (!held.ok) {
      await releaseHolds(holds, deps);
      return held;
    }
    holds.push(held.hold);
  }
  return { ok: true, holds };
}

async function releaseHolds(holds: readonly (CreditHold | null)[], deps: CreateImageJobsDeps): Promise<void> {
  for (const hold of holds) {
    if (!hold) continue;
    try {
      await releaseCreditHold(hold, deps.credits);
    } catch (error) {
      // The hold's pending row stays, so the hold sweep refunds it; never mask the refusal being returned.
      deps.logger.error('image_job_create_hold_release_failed', { error });
    }
  }
}

type PersistParams = {
  owner: JobOwner;
  input: CreateImageJobsInput;
  request: StoredImageRequest;
  providerId: ImageJob['payload']['providerId'];
  groupId: string;
  holds: readonly (CreditHold | null)[];
  keys: readonly (string | undefined)[];
  missingIndexes: readonly number[];
};

async function persistBatch(
  params: PersistParams,
  deps: CreateImageJobsDeps
): Promise<{ ok: true; jobs: ImageJob[] } | Refusal> {
  const { owner, input, request, providerId, groupId, holds, keys, missingIndexes } = params;
  const now = deps.now();
  const jobs: ImageJob[] = [];
  for (const [position, index] of missingIndexes.entries()) {
    let result: Awaited<ReturnType<typeof persistAndEnqueueJob<'image'>>>;
    try {
      result = await persistAndEnqueueJob(
        'image',
        {
          ...owner,
          requestedBy: input.user.id,
          ...(input.apiKeyId !== undefined && { apiKeyId: input.apiKeyId }),
          source: input.source,
          state: 'pending',
          payload: { request, providerId, groupId },
          pollCount: 0,
          attempts: 0,
          cancelRequested: false,
          nextPollAt: now,
          deadlineAt: new Date(now.getTime() + IMAGE_JOB_MAX_WALL_CLOCK_MS),
          ...(keys[index] !== undefined && { idempotencyKey: keys[index] }),
          creditHold: holds[position],
        },
        deps
      );
    } catch (error) {
      // persistAndEnqueueJob returned this job's hold; the ones not yet attached to a job are ours to return.
      await releaseHolds(holds.slice(position + 1), deps);
      throw error;
    }
    if (!result.ok) {
      await releaseHolds(holds.slice(position + 1), deps);
      return result;
    }
    jobs.push(result.job);
  }
  return { ok: true, jobs };
}

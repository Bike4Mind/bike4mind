import {
  estimateStudioRenderUsd,
  STUDIO_RENDER_IMAGE_EXTENSIONS,
  STUDIO_RENDER_MAX_OUTPUTS_PER_EXPORT,
  STUDIO_RENDER_JOB_DEADLINE_MS,
  StudioTimelineSchema,
  studioFileMediaKind,
  studioRenderBareMimeType,
  studioRenderBilledSeconds,
  studioTimelineFileIds,
  usdToCredits,
  validateStudioTimeline,
  type StudioTimeline,
  type StudioTimelineOutput,
} from '@bike4mind/common';
import { Types } from 'mongoose';
import { releaseCreditHold, type CreditHold } from '../creditService/creditHold';
import { assertPaidFeatureAccess } from '../llm/paidFeatureAdmission';
import { checkBatchSpendCap, holdJobCredits, persistAndEnqueueJob, resolveJobOwner } from '../generationJobs/createJob';
import {
  RENDER_OUTPUT_BYTES_PER_SECOND_ESTIMATE,
  type CreateRenderJobsDeps,
  type CreateRenderJobsInput,
  type CreateRenderJobsRefusalCode,
  type CreateRenderJobsResult,
  type RenderJob,
} from './types';

export const RENDER_FEATURE_LABEL = 'studio render';
const RENDER_PAID_FEATURE_LABEL = 'Video export';

type Refusal = Extract<CreateRenderJobsResult, { ok: false }>;

const refuse = (status: number, code: CreateRenderJobsRefusalCode, message: string): Refusal => ({
  ok: false,
  status,
  code,
  message,
});

const timelineHasContent = (timeline: StudioTimeline): boolean =>
  timeline.tracks.some(track => track.enabled && track.clips.length > 0);

/**
 * What the worker renders: disabled tracks are skipped, so their files neither need to be readable nor playable.
 * Caption sync links are an editor concern, so they are dropped too: a caption synced to a voice clip on a disabled
 * track still renders at its own time.
 */
const enabledTracksOnly = (timeline: StudioTimeline): StudioTimeline => ({
  ...timeline,
  tracks: timeline.tracks
    .filter(track => track.enabled)
    .map(track =>
      track.kind === 'captions'
        ? { ...track, clips: track.clips.map(({ syncedVoiceClipId: _link, ...clip }) => clip) }
        : track
    ),
});

/** The first image clip whose type the worker cannot decode, so it is refused at submit rather than after queueing. */
const findUndecodableImageClipId = (
  timeline: StudioTimeline,
  mimeTypes: ReadonlyMap<string, string>
): string | null => {
  for (const track of timeline.tracks) {
    if (track.kind === 'captions') continue;
    for (const clip of track.clips) {
      const mimeType = mimeTypes.get(clip.fileId);
      if (mimeType === undefined || studioFileMediaKind(mimeType) !== 'image') continue;
      if (!Object.hasOwn(STUDIO_RENDER_IMAGE_EXTENSIONS, studioRenderBareMimeType(mimeType))) return clip.id;
    }
  }
  return null;
};

const selectOutputs = (timeline: StudioTimeline, outputIds: readonly string[]): StudioTimelineOutput[] | Refusal => {
  const unique = [...new Set(outputIds)];
  if (unique.length === 0 || unique.length > STUDIO_RENDER_MAX_OUTPUTS_PER_EXPORT) {
    return refuse(422, 'invalid_outputs', `Pick between 1 and ${STUDIO_RENDER_MAX_OUTPUTS_PER_EXPORT} output sizes`);
  }
  const byId = new Map(timeline.outputs.map(output => [output.id, output]));
  const outputs = unique.map(id => byId.get(id));
  if (outputs.some(output => !output)) return refuse(422, 'invalid_outputs', 'An output size is not on this timeline');
  return outputs.filter((output): output is StudioTimelineOutput => output !== undefined);
};

/** Parses the stored spec and checks it renders now: valid, not empty, and every file still readable and playable. */
const loadRenderableTimeline = async (
  input: CreateRenderJobsInput,
  deps: CreateRenderJobsDeps
): Promise<{ title: string; timeline: StudioTimeline } | Refusal> => {
  const composition = await deps.findComposition(input.compositionId, input.user.id);
  if (!composition) return refuse(404, 'composition_not_found', 'Production not found');
  const parsed = StudioTimelineSchema.safeParse(composition.timeline);
  if (!parsed.success) return refuse(422, 'invalid_timeline', 'The timeline is not valid; fix it in the editor first');
  const timeline = parsed.data;
  if (!timelineHasContent(timeline)) return refuse(422, 'empty_timeline', 'The timeline has nothing to render');

  const rendered = enabledTracksOnly(timeline);
  const readable = await deps.findReadableFiles(studioTimelineFileIds(rendered), input.user.id);
  const fileKinds = new Map([...readable].map(([id, mimeType]) => [id, studioFileMediaKind(mimeType)]));
  const issues = validateStudioTimeline(rendered, { knownFileIds: new Set(readable.keys()), fileKinds });
  if (issues.some(issue => issue.code === 'unknown_file')) {
    return refuse(422, 'input_file_not_found', 'A clip uses a file you can no longer open');
  }
  if (issues.length > 0) return refuse(422, 'invalid_timeline', issues[0].message);
  const undecodableClipId = findUndecodableImageClipId(rendered, readable);
  if (undecodableClipId !== null) {
    return refuse(
      422,
      'invalid_timeline',
      `Clip "${undecodableClipId}" is an image type that cannot be exported; use PNG, JPEG, WebP, GIF, BMP or TIFF`
    );
  }
  return { title: composition.title, timeline };
};

/**
 * Starts one export: a render job per selected output size, under one group id. Each job holds its own credits up
 * front (priced from the StudioRenderPricing snapshot) and is settled on delivery or refunded on failure by the
 * render handler. Holds that never reach a persisted job are returned here. Throws ForbiddenError for a free-tier
 * requester (see assertPaidFeatureAccess).
 */
export async function createRenderJobs(
  input: CreateRenderJobsInput,
  deps: CreateRenderJobsDeps
): Promise<CreateRenderJobsResult> {
  // A render is not a model call, so model admission never sees it: hold it to the same free-tier rule here.
  await assertPaidFeatureAccess({
    user: input.user,
    planlessDeployment: deps.planlessDeployment,
    getEntitlements: input.getEntitlements,
    featureLabel: RENDER_PAID_FEATURE_LABEL,
  });
  const loaded = await loadRenderableTimeline(input, deps);
  if ('ok' in loaded) return loaded;
  const { title, timeline } = loaded;
  const outputs = selectOutputs(timeline, input.outputIds);
  if ('ok' in outputs) return outputs;

  const billedSeconds = studioRenderBilledSeconds(timeline);
  const storage = await deps.checkStorageFor(
    input.user.id,
    outputs.length * billedSeconds * RENDER_OUTPUT_BYTES_PER_SECOND_ESTIMATE
  );
  if (storage) return { ...refuse(400, 'storage_quota_exceeded', 'Storage quota exceeded'), storage };

  const { enforceCredits, pricing } = await deps.getSettings();
  const priced = outputs.map(output => {
    const usd = estimateStudioRenderUsd(timeline, output.aspectRatio, pricing);
    return {
      output,
      pricing: { usdPerOutputSecond: pricing.usdPerOutputSecond[output.aspectRatio], billedSeconds, usd },
      credits: usdToCredits(usd),
    };
  });

  const holds = await holdAll(
    priced.map(entry => entry.credits),
    { enforceCredits, user: input.user },
    deps
  );
  if (!holds.ok) return holds;

  const groupId = new Types.ObjectId().toHexString();
  const owner = resolveJobOwner(input.user);
  const now = deps.now();
  const jobs: RenderJob[] = [];
  for (const [index, entry] of priced.entries()) {
    let result: Awaited<ReturnType<typeof persistAndEnqueueJob<'render'>>>;
    try {
      result = await persistAndEnqueueJob(
        'render',
        {
          ...owner,
          requestedBy: input.user.id,
          source: 'studio',
          state: 'pending',
          payload: {
            request: { compositionId: input.compositionId, title, output: entry.output, timeline },
            pricing: entry.pricing,
            groupId,
            groupSize: priced.length,
          },
          pollCount: 0,
          attempts: 0,
          cancelRequested: false,
          nextPollAt: now,
          deadlineAt: new Date(now.getTime() + STUDIO_RENDER_JOB_DEADLINE_MS),
          creditHold: holds.holds[index],
        },
        deps
      );
    } catch (error) {
      // persistAndEnqueueJob returned this job's hold; the ones not yet attached to a job are ours to return.
      await releaseHolds(holds.holds.slice(index + 1), deps);
      throw error;
    }
    // No idempotency key is sent, so a replay refusal cannot happen; handled for the type's sake.
    if (!result.ok) {
      await releaseHolds(holds.holds.slice(index + 1), deps);
      throw new Error(`render job create refused unexpectedly: ${result.code}`);
    }
    jobs.push(result.job);
  }
  return { ok: true, groupId, jobs };
}

async function holdAll(
  credits: readonly number[],
  params: { enforceCredits: boolean; user: CreateRenderJobsInput['user'] },
  deps: CreateRenderJobsDeps
): Promise<{ ok: true; holds: (CreditHold | null)[] } | Refusal> {
  if (credits.length > 1) {
    const total = credits.reduce((sum, value) => sum + value, 0);
    const capped = await checkBatchSpendCap({ ...params, totalCredits: total }, deps);
    if (capped) return capped;
  }
  const holds: (CreditHold | null)[] = [];
  for (const requiredCredits of credits) {
    let held: Awaited<ReturnType<typeof holdJobCredits>>;
    try {
      held = await holdJobCredits({ ...params, requiredCredits, featureLabel: RENDER_FEATURE_LABEL }, deps);
    } catch (error) {
      await releaseHolds(holds, deps);
      throw error;
    }
    if (!held.ok) {
      await releaseHolds(holds, deps);
      return held;
    }
    holds.push(held.hold);
  }
  return { ok: true, holds };
}

async function releaseHolds(holds: readonly (CreditHold | null)[], deps: CreateRenderJobsDeps): Promise<void> {
  for (const hold of holds) {
    if (!hold) continue;
    try {
      await releaseCreditHold(hold, deps.credits);
    } catch (error) {
      // No sweep refunds a create-time hold, so the log carries what to return by hand; never mask the refusal.
      deps.logger.error('render_job_create_hold_release_failed', {
        ownerId: hold.ownerId,
        ownerType: hold.ownerType,
        reservedCredits: hold.reservedCredits,
        error,
      });
    }
  }
}

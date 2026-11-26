import {
  MAX_VIDEO_OUTPUT_BYTES,
  type StudioCompositionResponse,
  type StudioCompositionSummaryResponse,
  type StudioRenderJob,
} from '@bike4mind/common';
import type {
  ProductionDetail,
  ProductionFileRef,
  ProductionMedia,
  ProductionRef,
  ProductionRename,
  ProductionRenderJob,
  ProductionRenderRequest,
  ProductionReorder,
  ProductionsListRequest,
  ProductionsPage,
  ProductionsResult,
  ProductionSummary,
} from '@shared/productions';
import type { MediaApiClient } from '../media/MediaApiClient';
import { isSupportedMediaType, type MediaStore } from '../media/MediaStore';
import { ProductionsError, type ProductionsClient } from './ProductionsClient';
import { ReorderError, reorderTrackClips } from './reorderClips';

/** The MediaStore bucket finished renders download into. Cleared at start and on an account change. */
export const PRODUCTIONS_BUCKET = 'productions-cache';

export const PRODUCTIONS_PAGE_SIZE = 50;

export interface ProductionsDeps {
  /** The bearer-bound clients and the account scope they belong to, or null when signed out. */
  connection(): { scope: string; productions: ProductionsClient; files: MediaApiClient } | null;
  media: Pick<MediaStore, 'saveStream' | 'clearReusableBucket'>;
}

export function toSummary(composition: StudioCompositionSummaryResponse): ProductionSummary {
  return {
    id: composition.id,
    title: composition.title,
    template: composition.template,
    updatedAt: composition.updatedAt.toISOString(),
  };
}

export function toDetail(composition: StudioCompositionResponse): ProductionDetail {
  const shotTitleByFile = new Map<string, string>();
  for (const shot of composition.shots) {
    for (const fileId of [shot.clipFileId, shot.chosenFileId]) {
      if (fileId && !shotTitleByFile.has(fileId)) shotTitleByFile.set(fileId, shot.title);
    }
  }
  const { timeline } = composition;
  let otherClipCount = 0;
  const videoTracks: ProductionDetail['videoTracks'] = [];
  for (const track of timeline.tracks) {
    if (track.kind !== 'video') {
      otherClipCount += track.clips.length;
      continue;
    }
    const sorted = [...track.clips].sort((a, b) => a.startMs - b.startMs);
    // Numbered by id, not position, so a fallback label stays with its clip when the order changes.
    const ordinal = new Map([...track.clips].sort((a, b) => (a.id < b.id ? -1 : 1)).map((clip, i) => [clip.id, i + 1]));
    videoTracks.push({
      id: track.id,
      enabled: track.enabled,
      clips: sorted.map(clip => ({
        id: clip.id,
        label: shotTitleByFile.get(clip.fileId) ?? `Clip ${ordinal.get(clip.id)}`,
        startMs: clip.startMs,
        durationMs: clip.durationMs,
      })),
    });
  }
  return {
    ...toSummary(composition),
    durationMs: timeline.durationMs,
    outputs: timeline.outputs.map(({ id, aspectRatio, width, height }) => ({ id, aspectRatio, width, height })),
    videoTracks,
    otherClipCount,
  };
}

export function toRenderJob(job: StudioRenderJob): ProductionRenderJob {
  return {
    id: job.id,
    groupId: job.groupId,
    state: job.state,
    progress: job.progress,
    output: job.output,
    errorMessage: job.error?.message ?? null,
    fileId: job.file?.fileId ?? null,
    durationSeconds: job.file?.durationSeconds ?? null,
    createdAt: job.createdAt,
  };
}

async function settle<T>(work: () => Promise<T>): Promise<ProductionsResult<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    if (error instanceof ProductionsError) return { ok: false, error: { kind: error.kind, message: error.message } };
    if (error instanceof ReorderError) return { ok: false, error: { kind: 'failed', message: error.message } };
    return { ok: false, error: { kind: 'failed', message: error instanceof Error ? error.message : String(error) } };
  }
}

/**
 * The Productions tab's main-process half. Failures come back as a `ProductionsResult` rather than
 * a thrown error, because an IPC rejection loses everything but its message and the tab needs the kind.
 */
export class ProductionsService {
  private scope: string | null = null;
  private readonly stored = new Map<string, Promise<ProductionMedia>>();
  private clearing: Promise<void>;

  constructor(private readonly deps: ProductionsDeps) {
    // Files from an earlier run are unreachable (nothing maps a render to them any more).
    this.clearing = this.clearBucket();
  }

  private clearBucket(): Promise<void> {
    return this.deps.media.clearReusableBucket(PRODUCTIONS_BUCKET).catch(() => {});
  }

  list(request: ProductionsListRequest): Promise<ProductionsResult<ProductionsPage>> {
    return settle(async () => {
      const skip = request.skip ?? 0;
      const rows = await this.connect().productions.list({ limit: PRODUCTIONS_PAGE_SIZE, skip });
      return {
        items: rows.map(toSummary),
        nextSkip: rows.length < PRODUCTIONS_PAGE_SIZE ? null : skip + rows.length,
      };
    });
  }

  get(ref: ProductionRef): Promise<ProductionsResult<ProductionDetail>> {
    return settle(async () => toDetail(await this.connect().productions.get(ref.id)));
  }

  rename(request: ProductionRename): Promise<ProductionsResult<ProductionDetail>> {
    return settle(async () =>
      toDetail(await this.connect().productions.update(request.id, { title: request.title }, 'Renaming the production'))
    );
  }

  reorder(request: ProductionReorder): Promise<ProductionsResult<ProductionDetail>> {
    return settle(async () => {
      const { productions } = this.connect();
      // Re-read first: PATCH replaces the whole timeline, so it must be built from the newest one.
      const current = await productions.get(request.id);
      const timeline = reorderTrackClips(current.timeline, request.trackId, request.clipIds);
      return toDetail(await productions.update(request.id, { timeline }, 'Saving the clip order'));
    });
  }

  renders(ref: ProductionRef): Promise<ProductionsResult<ProductionRenderJob[]>> {
    return settle(async () => (await this.connect().productions.renders(ref.id)).map(toRenderJob));
  }

  render(request: ProductionRenderRequest): Promise<ProductionsResult<ProductionRenderJob[]>> {
    return settle(async () =>
      (await this.connect().productions.render(request.id, request.outputIds)).map(toRenderJob)
    );
  }

  media(ref: ProductionFileRef): Promise<ProductionsResult<ProductionMedia>> {
    return settle(async () => {
      const { files } = this.connect();
      const cached = this.stored.get(ref.fileId);
      if (cached) return cached;
      const scope = this.scope;
      const download = this.download(ref.fileId, files).catch((error: unknown) => {
        // A failure is not cached, so asking again retries it.
        if (this.scope === scope) this.stored.delete(ref.fileId);
        throw error;
      });
      this.stored.set(ref.fileId, download);
      return download;
    });
  }

  /** The current connection; an account change drops the downloads tied to the previous one. */
  private connect() {
    const connection = this.deps.connection();
    if (!connection) throw new ProductionsError('signed-out', 'Sign in to see your Productions.');
    if (connection.scope !== this.scope) {
      if (this.scope !== null) this.clearing = this.clearing.then(() => this.clearBucket());
      this.scope = connection.scope;
      this.stored.clear();
    }
    return connection;
  }

  private async download(fileId: string, files: MediaApiClient): Promise<ProductionMedia> {
    await this.clearing;
    const file = await files.getFile(fileId).catch((error: unknown) => {
      // getFile words its failure for an input image; say what this read was for.
      throw new ProductionsError(
        'failed',
        `Reading the export failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
    if (file.moderation_status === 'blocked') throw new ProductionsError('failed', 'This export was blocked.');
    // The job can turn succeeded a moment before its file serves a URL; the web retries the same way.
    if (!file.download_url) throw new ProductionsError('not-ready', 'The export is still being saved.');
    const opened = await files.openVideoDownload(file.download_url, new AbortController().signal);
    const type = isSupportedMediaType(opened.contentType) ? opened.contentType : file.mime_type || 'video/mp4';
    const saved = await this.deps.media.saveStream(PRODUCTIONS_BUCKET, opened.stream, type, MAX_VIDEO_OUTPUT_BYTES);
    return { url: saved.url, mimeType: saved.mimeType };
  }
}

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  CreateMusicGenerationBodySchema,
  CreateVideoGenerationBodySchema,
  GenerateImageRequestBodySchema,
  soundEffectsRequestSchema,
  ttsRequestSchema,
} from '@bike4mind/common';
import { studioProvenanceSchema, type StudioAsset, type StudioJob } from '@shared/studio';
import { isTerminalQuest, type MediaApiClient } from '../../media/MediaApiClient';
import { MediaStore, parseMediaUrl } from '../../media/MediaStore';
import { resolveImageUrls } from '../../media/imageGeneration';
import type { StudioWorkspaceStore } from '../StudioWorkspaceStore';

export const studioGenerationRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('image'),
    body: GenerateImageRequestBodySchema.pick({ prompt: true, model: true }).extend({ size: z.string().optional() }),
  }),
  z.object({ kind: z.literal('video'), body: CreateVideoGenerationBodySchema }),
  z.object({ kind: z.literal('music'), body: CreateMusicGenerationBodySchema }),
  z.object({ kind: z.literal('speech'), body: ttsRequestSchema.omit({ encoding: true }) }),
  z.object({
    kind: z.literal('sound-effect'),
    body: soundEffectsRequestSchema.omit({ encoding: true, preview: true }),
  }),
]);
export type StudioGenerationRequest = z.input<typeof studioGenerationRequestSchema> & {
  title?: string;
  provenance?: StudioAsset['provenance'];
};

export interface StudioGenerationConnection {
  scope: string;
  client: MediaApiClient;
  cdnUrl: string;
}

export interface StudioGenerationDeps {
  workspaces: StudioWorkspaceStore;
  media: MediaStore;
  connection(): StudioGenerationConnection | null;
  /** Must verify reviewed context and obtain paid approval for this exact request. */
  authorize(input: { sessionId: string; request: StudioGenerationRequest }): Promise<boolean>;
}

const terminal = new Set<StudioJob['state']>(['completed', 'failed', 'cancelled']);
const bucketFor = (scope: string, workspace: string, asset: string) =>
  createHash('sha256')
    .update(JSON.stringify(['studio', scope, workspace, asset]))
    .digest('hex');

/** Construct once per desktop runtime. Recovery only reads jobs; it never submits paid work. */
export class StudioGenerationService {
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: StudioGenerationDeps) {}

  async importChatAsset(sessionId: string, asset: StudioAsset): Promise<void> {
    const connection = this.requireConnection();
    const workspace = await this.requireWorkspace(sessionId, connection);
    const source = parseMediaUrl(asset.url);
    if (!source || source.sessionId !== asset.originatingSessionId) throw new Error('Invalid chat asset location.');
    await this.lock(`${connection.scope}:${workspace.workspaceId}`, async () => {
      if (await this.deps.workspaces.getJob(sessionId, asset.id)) return;
      const file = await this.deps.media.read(source.sessionId, source.name);
      this.assertConnection(connection);
      if (!file) return;
      const stored = await this.deps.media.saveForContent(
        bucketFor(connection.scope, workspace.workspaceId, asset.id),
        file.bytes,
        file.bytes,
        file.mimeType
      );
      this.assertConnection(connection);
      if (
        !(await this.deps.workspaces.upsertAsset(
          sessionId,
          { ...asset, url: stored.url, mimeType: stored.mimeType },
          connection.scope
        ))
      )
        throw new Error('Studio workspace unavailable.');
      await this.saveJob(
        sessionId,
        {
          id: asset.id,
          kind: asset.kind,
          originatingSessionId: asset.originatingSessionId,
          state: 'completed',
          createdAt: asset.createdAt,
          updatedAt: asset.updatedAt,
          idempotencyKey: asset.id,
          assetIds: [asset.id],
        },
        connection
      );
    });
  }

  async submit(sessionId: string, input: StudioGenerationRequest): Promise<StudioJob> {
    const request = {
      ...studioGenerationRequestSchema.parse(input),
      ...(input.title !== undefined ? { title: z.string().max(500).parse(input.title) } : {}),
      ...(input.provenance ? { provenance: studioProvenanceSchema.parse(input.provenance) } : {}),
    };
    const connection = this.requireConnection();
    const workspace = await this.requireWorkspace(sessionId, connection);
    const now = new Date().toISOString();
    let job: StudioJob = {
      id: randomUUID(),
      kind: request.kind,
      originatingSessionId: sessionId,
      state: 'submitting',
      createdAt: now,
      updatedAt: now,
      idempotencyKey: randomUUID(),
      assetIds: [],
      provenance: request.provenance,
    };
    return this.lock(`${connection.scope}:${workspace.workspaceId}`, async () => {
      if (!(await this.deps.authorize({ sessionId, request: structuredClone(request) }))) {
        throw new Error('Studio generation was not approved.');
      }
      this.assertConnection(connection);
      if ((await this.requireWorkspace(sessionId, connection)).workspaceId !== workspace.workspaceId) {
        throw new Error('The Studio workspace changed.');
      }
      await this.saveJob(sessionId, job, connection);
      try {
        if (request.kind === 'image') {
          const result = await connection.client.generateImage({ ...request.body, prompt_resolution: 'literal' });
          job = { ...job, state: 'queued', providerJobId: result.questId };
        } else if (request.kind === 'video' || request.kind === 'music') {
          const result =
            request.kind === 'video'
              ? await connection.client.createVideoGeneration(request.body, job.idempotencyKey)
              : await connection.client.createMusicGeneration(request.body, job.idempotencyKey);
          job = { ...job, state: 'queued', providerJobId: result.id };
        } else {
          const response =
            request.kind === 'speech'
              ? await connection.client.synthesizeSpeech(request.body)
              : await connection.client.generateSoundEffect(request.body);
          this.assertConnection(connection);
          const bytes =
            'audio' in response && Buffer.isBuffer(response.audio)
              ? response.audio
              : 'delivery' in response && response.delivery === 'url'
                ? (await connection.client.fetchGenerated(response.url)).bytes
                : Buffer.from(
                    typeof response.audio === 'string' ? response.audio : response.audio.toString('base64'),
                    'base64'
                  );
          await this.storeOutput(
            sessionId,
            workspace.workspaceId,
            job,
            0,
            bytes,
            response.contentType,
            connection,
            request.title
          );
          job = { ...job, state: 'completed', assetIds: [`${job.id}_0`] };
        }
        await this.saveJob(sessionId, job, connection);
        return job;
      } catch (error) {
        // A timeout can happen after billing. Never treat it as permission to submit again.
        job = {
          ...job,
          state: 'unknown',
          error: error instanceof Error ? error.message : 'Generation outcome unknown.',
        };
        await this.saveJob(sessionId, job, connection);
        return job;
      }
    });
  }

  async reconcile(sessionId: string, jobId: string): Promise<StudioJob> {
    const connection = this.requireConnection();
    const workspace = await this.requireWorkspace(sessionId, connection);
    return this.lock(`${connection.scope}:${workspace.workspaceId}`, async () => {
      let job = await this.findJob(sessionId, jobId, connection);
      if (terminal.has(job.state)) return job;
      if (job.kind === 'speech' || job.kind === 'sound-effect') {
        const asset = await this.findAsset(sessionId, `${job.id}_0`, connection);
        if (asset && (await this.locateAsset(sessionId, asset.id))) {
          job = { ...job, state: 'completed', assetIds: [asset.id], error: undefined };
          await this.saveJob(sessionId, job, connection);
          return job;
        }
      }
      if (!job.providerJobId) {
        job = { ...job, state: 'unknown', error: 'No recoverable remote job ID. Do not retry automatically.' };
        await this.saveJob(sessionId, job, connection);
        return job;
      }
      const outputs: { url: string; mimeType: string }[] = [];
      if (job.kind === 'image') {
        const remote = await connection.client.getQuest(job.providerJobId);
        this.assertConnection(connection);
        if (remote.type === 'error')
          job = { ...job, state: 'failed', error: remote.reply ?? 'Image generation failed.' };
        else if (isTerminalQuest(remote)) {
          if (remote.status === 'stopped') job = { ...job, state: 'cancelled' };
          else {
            outputs.push(
              ...resolveImageUrls(remote, connection.cdnUrl).urls.map(url => ({ url, mimeType: 'image/png' }))
            );
            if (!outputs.length) throw new Error('The image job has no downloadable output.');
          }
        } else job = { ...job, state: 'running' };
      } else if (job.kind === 'video' || job.kind === 'music') {
        const remote =
          job.kind === 'video'
            ? await connection.client.getVideoGeneration(job.providerJobId)
            : await connection.client.getMusicGeneration(job.providerJobId);
        this.assertConnection(connection);
        if (remote.state === 'failed' || remote.state === 'cancelled') {
          job = { ...job, state: remote.state, error: remote.error?.message };
        } else if (remote.state === 'succeeded') {
          if (remote.output?.availability === 'pending_scan') job = { ...job, state: 'running' };
          else if (remote.output?.availability === 'ready' && remote.output.url) {
            outputs.push({ url: remote.output.url, mimeType: remote.output.content_type });
          } else job = { ...job, state: 'failed', error: 'The generated output is unavailable.' };
        } else job = { ...job, state: 'running' };
      } else {
        job = { ...job, state: 'unknown', error: 'Inline audio cannot be recovered automatically.' };
      }
      for (const [index, output] of outputs.entries()) {
        const assetId = `${job.id}_${index}`;
        if (!(await this.findAsset(sessionId, assetId, connection))) {
          if (job.kind === 'video') {
            const download = await connection.client.openVideoDownload(output.url, new AbortController().signal);
            this.assertConnection(connection);
            const stored = await this.deps.media.saveStream(
              bucketFor(connection.scope, workspace.workspaceId, assetId),
              download.stream,
              output.mimeType,
              512 * 1024 * 1024
            );
            await this.saveAsset(sessionId, job, assetId, stored, connection);
          } else {
            const download = await connection.client.fetchGenerated(output.url);
            await this.storeOutput(
              sessionId,
              workspace.workspaceId,
              job,
              index,
              download.bytes,
              download.contentType || output.mimeType,
              connection
            );
          }
        }
      }
      if (outputs.length)
        job = { ...job, state: 'completed', assetIds: outputs.map((_, index) => `${job.id}_${index}`) };
      await this.saveJob(sessionId, job, connection);
      return job;
    });
  }

  async recover(sessionId: string): Promise<StudioJob[]> {
    const connection = this.requireConnection();
    const jobs = await this.allJobs(sessionId, connection);
    const recovered: StudioJob[] = [];
    for (const job of jobs) {
      if (terminal.has(job.state)) {
        recovered.push(job);
        continue;
      }
      try {
        recovered.push(await this.reconcile(sessionId, job.id));
      } catch {
        this.assertConnection(connection);
        recovered.push(job);
      }
    }
    return recovered;
  }

  async cancel(sessionId: string, jobId: string): Promise<StudioJob> {
    const connection = this.requireConnection();
    const workspace = await this.requireWorkspace(sessionId, connection);
    return this.lock(`${connection.scope}:${workspace.workspaceId}`, async () => {
      const job = await this.findJob(sessionId, jobId, connection);
      if (terminal.has(job.state)) return job;
      if (!job.providerJobId || (job.kind !== 'video' && job.kind !== 'music')) {
        throw new Error('This backend cannot cancel this generation.');
      }
      const remote =
        job.kind === 'video'
          ? await connection.client.cancelVideoGeneration(job.providerJobId)
          : await connection.client.cancelMusicGeneration(job.providerJobId);
      const updated = { ...job, state: remote.state === 'cancelled' ? ('cancelled' as const) : job.state };
      await this.saveJob(sessionId, updated, connection);
      return updated;
    });
  }

  async renameAsset(sessionId: string, assetId: string, title: string): Promise<void> {
    const connection = this.requireConnection();
    const workspace = await this.requireWorkspace(sessionId, connection);
    await this.lock(`${connection.scope}:${workspace.workspaceId}`, async () => {
      const asset = await this.findAsset(sessionId, assetId, connection);
      if (!asset) throw new Error('Studio asset not found.');
      if (
        !(await this.deps.workspaces.upsertAsset(
          sessionId,
          {
            ...asset,
            title: z.string().max(500).parse(title),
            updatedAt: new Date().toISOString(),
          },
          connection.scope
        ))
      )
        throw new Error('Studio workspace unavailable.');
    });
  }

  async locateAsset(sessionId: string, assetId: string) {
    const connection = this.requireConnection();
    const workspace = await this.requireWorkspace(sessionId, connection);
    const asset = await this.findAsset(sessionId, assetId, connection);
    if (!asset) return null;
    const parsed = parseMediaUrl(asset.url);
    const bucket = bucketFor(connection.scope, workspace.workspaceId, asset.id);
    if (parsed?.sessionId !== bucket) throw new Error('Invalid Studio asset location.');
    const located = await this.deps.media.locate(bucket, parsed.name);
    this.assertConnection(connection);
    return located;
  }

  async removeAsset(sessionId: string, assetId: string): Promise<void> {
    const connection = this.requireConnection();
    const workspace = await this.requireWorkspace(sessionId, connection);
    await this.lock(`${connection.scope}:${workspace.workspaceId}`, async () => {
      const asset = await this.findAsset(sessionId, assetId, connection);
      if (!asset) return;
      if (asset.jobId && !terminal.has((await this.findJob(sessionId, asset.jobId, connection)).state)) {
        throw new Error('Wait until the generation finishes before deleting an output.');
      }
      await this.deps.media.forgetSession(bucketFor(connection.scope, workspace.workspaceId, asset.id));
      if (!(await this.deps.workspaces.removeAsset(sessionId, asset.id, connection.scope))) {
        throw new Error('Studio workspace unavailable.');
      }
    });
  }

  private async storeOutput(
    sessionId: string,
    workspaceId: string,
    job: StudioJob,
    index: number,
    bytes: Buffer,
    mimeType: string,
    connection: StudioGenerationConnection,
    title?: string
  ) {
    this.assertConnection(connection);
    const id = `${job.id}_${index}`;
    const stored = await this.deps.media.saveForContent(
      bucketFor(connection.scope, workspaceId, id),
      bytes,
      bytes,
      mimeType
    );
    await this.saveAsset(sessionId, job, id, stored, connection, title);
  }

  private async saveAsset(
    sessionId: string,
    job: StudioJob,
    id: string,
    stored: { url: string; mimeType: string },
    connection: StudioGenerationConnection,
    title: string = job.kind
  ) {
    this.assertConnection(connection);
    const now = new Date().toISOString();
    if (
      !(await this.deps.workspaces.upsertAsset(
        sessionId,
        {
          id,
          jobId: job.id,
          kind: job.kind,
          originatingSessionId: job.originatingSessionId,
          title,
          url: stored.url,
          mimeType: stored.mimeType,
          createdAt: now,
          updatedAt: now,
          provenance: job.provenance,
        },
        connection.scope
      ))
    )
      throw new Error('Studio workspace unavailable.');
  }

  private async saveJob(sessionId: string, job: StudioJob, connection: StudioGenerationConnection) {
    this.assertConnection(connection);
    job.updatedAt = new Date().toISOString();
    if (!(await this.deps.workspaces.upsertJob(sessionId, job, connection.scope)))
      throw new Error('Studio workspace unavailable.');
  }

  private async allJobs(sessionId: string, connection: StudioGenerationConnection) {
    await this.requireWorkspace(sessionId, connection);
    const jobs: StudioJob[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.deps.workspaces.listJobs(sessionId, { cursor });
      this.assertConnection(connection);
      if (!page) throw new Error('Studio workspace unavailable.');
      jobs.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return jobs;
  }

  private async findJob(sessionId: string, id: string, connection: StudioGenerationConnection) {
    this.assertConnection(connection);
    const job = await this.deps.workspaces.getJob(sessionId, id);
    this.assertConnection(connection);
    if (!job) throw new Error('Studio job not found.');
    return job;
  }

  private async findAsset(sessionId: string, id: string, connection: StudioGenerationConnection) {
    this.assertConnection(connection);
    const asset = await this.deps.workspaces.getAsset(sessionId, id);
    this.assertConnection(connection);
    return asset ?? undefined;
  }

  private requireConnection() {
    const connection = this.deps.connection();
    if (!connection) throw new Error('Sign in to use Studio generation.');
    return connection;
  }

  private assertConnection(connection: StudioGenerationConnection) {
    if (this.deps.connection()?.scope !== connection.scope) throw new Error('The active Studio account changed.');
  }

  private async requireWorkspace(sessionId: string, connection: StudioGenerationConnection) {
    this.assertConnection(connection);
    const workspace = await this.deps.workspaces.get(sessionId);
    this.assertConnection(connection);
    if (!workspace) throw new Error('Studio workspace unavailable.');
    return workspace;
  }

  private async lock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(key) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    this.pending.set(key, result);
    try {
      return await result;
    } finally {
      if (this.pending.get(key) === result) this.pending.delete(key);
    }
  }
}

import { app, dialog, shell, type IpcMain } from 'electron';
import { copyFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { IPC_CHANNELS } from '@shared/ipc';
import { studioIdSchema } from '@shared/studio';
import { studioAssetActionSchema, type StudioDraft } from '@shared/studioIpc';
import type { AuthService } from '../../auth/AuthService';
import type { SessionStore } from '../SessionStore';
import type { ChatService } from '../ChatService';
import type { AttachmentStore } from '../AttachmentStore';
import type { MediaStore } from '../media/MediaStore';
import type { ModelCatalog } from '../ModelCatalog';
import type { ChatVideoJob } from '@shared/chat';
import { MediaApiClient } from '../media/MediaApiClient';
import { planVideoRequest, resolveVideoModel } from '../media/videoModels';
import { planMusicRequest } from '../media/musicModels';
import { StudioWorkspaceStore } from './StudioWorkspaceStore';
import { StudioLiveService } from './StudioLiveService';
import { StudioJobScheduler } from './StudioJobScheduler';
import {
  StudioGenerationService,
  studioGenerationRequestSchema,
  type StudioGenerationRequest,
} from './generation/StudioGenerationService';

export function registerStudio(deps: {
  ipc: IpcMain;
  directory: string;
  sessions: SessionStore;
  service: ChatService;
  attachments: AttachmentStore;
  media: MediaStore;
  models: ModelCatalog;
  auth: AuthService;
  videoJobs(sessionId: string): Promise<ChatVideoJob[]>;
  changed(event: { sessionId: string; workspaceId: string }): void;
}) {
  const { sessions, auth, ipc } = deps;
  const workspaces = new StudioWorkspaceStore(join(deps.directory, 'studio'), sessions);
  const generation = new StudioGenerationService({
    workspaces,
    media: deps.media,
    connection: () => {
      const scope = sessions.scopeKey();
      const api = auth.getApiClient();
      return scope && api ? { scope, client: new MediaApiClient(api), cdnUrl: '' } : null;
    },
    authorize: async ({ sessionId, request }) => {
      // The generation service parses a copy; bind the single authorization to its exact body.
      const key = JSON.stringify({ scope: sessions.scopeKey(), sessionId, request });
      const authorize = authorizations.get(key);
      authorizations.delete(key);
      return authorize ? authorize() : false;
    },
  });
  const authorizations = new Map<string, () => Promise<boolean>>();
  let availability: { scope: string | null; expires: number; unavailable: string[] } | undefined;
  const live = new StudioLiveService({
    sessions,
    workspaces,
    attachments: deps.attachments,
    roots: id => deps.service.studioContextRoots(id),
    prepare: (...args) => deps.service.prepareStudioText(...args),
    available: () => !!auth.getApiClient(),
    unavailableKinds: async () => {
      const scope = sessions.scopeKey();
      const api = auth.getApiClient();
      if (!api) return ['image', 'video', 'music', 'speech', 'sound-effect'];
      if (availability?.scope === scope && availability.expires > Date.now()) return availability.unavailable;
      const [images, videos, music] = await Promise.all([
        deps.models.listImageModels(),
        deps.models.listVideoModels(),
        new MediaApiClient(api).listMusicModels().catch(() => []),
      ]);
      if (scope !== sessions.scopeKey()) throw new Error('Account changed.');
      const unavailable = [
        ...(!images.length ? ['image'] : []),
        ...(!videos.length ? ['video'] : []),
        ...(!music.length ? ['music'] : []),
      ];
      availability = { scope, expires: Date.now() + 60_000, unavailable };
      return unavailable;
    },
    changed: deps.changed,
    generation: {
      recover: id => (auth.getApiClient() ? generation.recover(id) : Promise.resolve([])),
      submit: async (sessionId, draft, prompt, provenance, authorize) => {
        const scope = sessions.scopeKey();
        const request = { ...studioGenerationRequestSchema.parse(await generationRequest(draft, prompt)), provenance };
        if (scope !== sessions.scopeKey()) throw new Error('Account changed.');
        const key = JSON.stringify({ scope, sessionId, request });
        authorizations.set(key, authorize);
        try {
          return await generation.submit(sessionId, request);
        } finally {
          authorizations.delete(key);
        }
      },
    },
  });
  async function generationRequest(draft: StudioDraft, prompt: string): Promise<StudioGenerationRequest> {
    const settings = draft.settings;
    switch (draft.kind) {
      case 'image': {
        const offered = await deps.models.listImageModels();
        const model = settings.model ?? offered[0];
        if (model && !offered.includes(model)) throw new Error('The saved image model is no longer available.');
        if (!model) throw new Error('No image models are available.');
        return { kind: 'image', body: { prompt, model, ...(settings.size ? { size: settings.size } : {}) } };
      }
      case 'video': {
        const model = resolveVideoModel(await deps.models.listVideoModels(), settings.model);
        const { request } = planVideoRequest(model, { prompt, withImage: false, ...settings });
        return {
          kind: 'video',
          body: {
            model: request.model,
            mode: request.mode,
            prompt,
            duration_seconds: request.durationSeconds,
            aspect_ratio: request.aspectRatio,
            resolution: request.resolution,
          },
        };
      }
      case 'music': {
        const api = auth.getApiClient();
        if (!api) throw new Error('Sign in first.');
        const offered = await new MediaApiClient(api).listMusicModels();
        const real = offered.filter(model => model.provider !== 'test');
        const pool = real.length ? real : offered;
        const model = settings.model
          ? offered.find(model => model.id === settings.model)
          : (pool.find(model => !model.preview) ?? pool[0]);
        if (!model) throw new Error('No music models are available.');
        planMusicRequest(model, settings);
        return {
          kind: 'music',
          body: {
            model: model.id,
            prompt,
            duration_seconds: settings.durationSeconds,
            instrumental: settings.instrumental,
          },
        };
      }
      case 'speech':
        return studioGenerationRequestSchema.parse({
          kind: 'speech',
          body: { text: prompt, voice: settings.voice, format: settings.format },
        });
      case 'sound-effect':
        return studioGenerationRequestSchema.parse({
          kind: 'sound-effect',
          body: { text: prompt, durationSeconds: settings.durationSeconds, promptInfluence: settings.promptInfluence },
        });
    }
  }
  const indexed = new Map<string, string>();
  const indexedFamilies = new Set<string>();
  async function indexChatSession(sessionId: string, force = false) {
    if (!auth.getApiClient()) return;
    const scope = sessions.scopeKey();
    const session = await sessions.get(sessionId);
    if (!session || scope !== sessions.scopeKey()) return;
    const key = `${scope}:${sessionId}`;
    if (!force && indexed.get(key) === session.updatedAt) return;
    for (const message of session.messages) {
      for (const call of message.toolCalls ?? []) {
        for (const [index, media] of (call.media ?? []).entries()) {
          if (scope !== sessions.scopeKey()) return;
          const kind =
            media.kind === 'image'
              ? 'image'
              : call.name === 'generate_music'
                ? 'music'
                : call.name === 'generate_sound_effect'
                  ? 'sound-effect'
                  : 'speech';
          const id = createHash('sha256')
            .update(JSON.stringify([sessionId, call.id, index, media.url]))
            .digest('hex');
          await generation.importChatAsset(sessionId, {
            id,
            kind,
            originatingSessionId: sessionId,
            title: media.caption.slice(0, 256) || kind,
            url: media.url,
            mimeType: media.mimeType,
            prompt: media.caption,
            createdAt: message.createdAt,
            updatedAt: message.createdAt,
          });
        }
      }
    }
    for (const job of await deps.videoJobs(sessionId)) {
      if (scope !== sessions.scopeKey()) return;
      if (job.state !== 'succeeded' || !job.media) continue;
      const id = createHash('sha256')
        .update(JSON.stringify(['chat-video', sessionId, job.id]))
        .digest('hex');
      await generation.importChatAsset(sessionId, {
        id,
        kind: 'video',
        originatingSessionId: sessionId,
        title: job.prompt.slice(0, 256) || 'Video',
        url: job.media.url,
        mimeType: job.media.mimeType,
        prompt: job.prompt,
        model: job.modelId,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      });
    }
    if (scope === sessions.scopeKey()) {
      if (indexed.size >= 512) indexed.delete(indexed.keys().next().value!);
      indexed.set(key, session.updatedAt);
    }
  }
  ipc.handle(IPC_CHANNELS.studioGet, async (_event, id: unknown) => {
    const sessionId = studioIdSchema.parse(id);
    const scope = sessions.scopeKey();
    const workspace = await sessions.resolveStudioWorkspace(sessionId, scope);
    if (!workspace) throw new Error('Studio workspace unavailable.');
    const familyKey = `${scope}:${workspace.workspaceId}`;
    if (!indexedFamilies.has(familyKey)) {
      for (const candidate of (await sessions.list()).slice(0, 256)) {
        if (scope !== sessions.scopeKey()) throw new Error('Account changed.');
        if (
          candidate.id === sessionId ||
          (await sessions.resolveStudioWorkspace(candidate.id, scope))?.workspaceId === workspace.workspaceId
        )
          await indexChatSession(candidate.id);
      }
      if (indexedFamilies.size >= 256) indexedFamilies.clear();
      indexedFamilies.add(familyKey);
    }
    return live.get(sessionId);
  });
  ipc.handle(IPC_CHANNELS.studioPrepare, (_event, draft: unknown) => live.prepare(draft));
  ipc.handle(IPC_CHANNELS.studioPage, (_event, request: unknown) => live.page(request));
  ipc.handle(IPC_CHANNELS.studioJobAction, async (_event, raw: unknown) => {
    const request = z
      .object({ sessionId: studioIdSchema, jobId: studioIdSchema, action: z.enum(['recheck', 'cancel']) })
      .strict()
      .parse(raw);
    const scope = sessions.scopeKey();
    if (request.action === 'cancel') await generation.cancel(request.sessionId, request.jobId);
    else await generation.reconcile(request.sessionId, request.jobId);
    const workspace = await sessions.resolveStudioWorkspace(request.sessionId, scope);
    if (workspace && scope === sessions.scopeKey())
      deps.changed({ sessionId: request.sessionId, workspaceId: workspace.workspaceId });
  });
  ipc.handle(IPC_CHANNELS.studioCreate, (_event, request: unknown) => live.create(request));
  ipc.handle(IPC_CHANNELS.studioPickFiles, async (_event, id: unknown) => {
    const sessionId = studioIdSchema.parse(id);
    const scope = sessions.scopeKey();
    if (!(await sessions.get(sessionId))) throw new Error('Session unavailable.');
    const picked = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
    if (scope !== sessions.scopeKey() || !(await sessions.get(sessionId))) throw new Error('Account changed.');
    return picked.canceled ? [] : picked.filePaths.slice(0, 32);
  });
  ipc.handle(IPC_CHANNELS.studioAssetAction, async (_event, raw: unknown) => {
    const request = studioAssetActionSchema.parse(raw);
    const scope = sessions.scopeKey();
    await live.asset(request.sessionId, request.assetId);
    const identity = await sessions.resolveStudioWorkspace(request.sessionId, scope);
    const assertActive = async () => {
      const current = await sessions.resolveStudioWorkspace(request.sessionId, scope);
      if (!identity || current?.workspaceId !== identity.workspaceId || scope !== sessions.scopeKey())
        throw new Error('Studio session changed.');
    };
    await assertActive();
    if (request.action === 'rename') {
      if (!request.title) throw new Error('Title is required.');
      await generation.renameAsset(request.sessionId, request.assetId, request.title);
    } else if (request.action === 'delete') {
      await generation.removeAsset(request.sessionId, request.assetId);
    } else {
      const file = await generation.locateAsset(request.sessionId, request.assetId);
      if (!file) throw new Error('Local asset is unavailable.');
      await assertActive();
      if (request.action === 'preview') await shell.openPath(file.path);
      if (request.action === 'export') {
        const picked = await dialog.showSaveDialog({
          defaultPath: join(app.getPath('downloads'), basename(file.path)),
        });
        await assertActive();
        if (!picked.canceled && picked.filePath) await copyFile(file.path, picked.filePath);
      }
      if (request.action === 'reuse') throw new Error('Use the exported file as an attachment.');
    }
    const workspace = await sessions.resolveStudioWorkspace(request.sessionId, scope);
    if (workspace && scope === sessions.scopeKey())
      deps.changed({ sessionId: request.sessionId, workspaceId: workspace.workspaceId });
  });
  const timer = setInterval(() => {
    if (lastScope !== sessions.scopeKey()) {
      lastScope = sessions.scopeKey();
      live.invalidate();
      authorizations.clear();
      indexed.clear();
      indexedFamilies.clear();
      availability = undefined;
    }
  }, 500);
  let lastScope = sessions.scopeKey();
  timer.unref();
  const scheduler = new StudioJobScheduler({
    scope: () => (auth.getApiClient() ? sessions.scopeKey() : null),
    sessions: async () => {
      const scope = sessions.scopeKey();
      const listed = await sessions.list();
      if (scope !== sessions.scopeKey()) return [];
      if (Date.now() >= nextCleanup) {
        nextCleanup = Date.now() + 60 * 60_000;
        const active = new Set<string>();
        for (const session of listed) {
          const identity = session.studioWorkspaceId
            ? { workspaceId: session.studioWorkspaceId }
            : await sessions.resolveStudioWorkspace(session.id, scope);
          if (identity) active.add(identity.workspaceId);
        }
        if (scope === sessions.scopeKey()) await generation.pruneOrphans(active);
      }
      return listed;
    },
    workspace: (id, scope) => sessions.resolveStudioWorkspace(id, scope),
    recover: id => generation.recover(id),
    changed: (sessionId, workspaceId) => deps.changed({ sessionId, workspaceId }),
  });
  let nextCleanup = 0;
  scheduler.start();
  const dispose = () => {
    scheduler.dispose();
    clearInterval(timer);
    live.invalidate();
    authorizations.clear();
    indexed.clear();
    indexedFamilies.clear();
  };
  app.once('before-quit', dispose);
  return { live, generation, dispose, indexChatSession };
}

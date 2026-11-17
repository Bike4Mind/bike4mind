import { app, dialog, shell, type IpcMain } from 'electron';
import { copyFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { IPC_CHANNELS } from '@shared/ipc';
import { studioIdSchema } from '@shared/studio';
import { studioAssetActionSchema, type StudioDraft } from '@shared/studioIpc';
import type { AuthService } from '../../auth/AuthService';
import type { SessionStore } from '../SessionStore';
import type { ChatService } from '../ChatService';
import type { AttachmentStore } from '../AttachmentStore';
import type { MediaStore } from '../media/MediaStore';
import type { ModelCatalog } from '../ModelCatalog';
import { MediaApiClient } from '../media/MediaApiClient';
import { planVideoRequest, resolveVideoModel } from '../media/videoModels';
import { planMusicRequest } from '../media/musicModels';
import { StudioWorkspaceStore } from './StudioWorkspaceStore';
import { StudioLiveService } from './StudioLiveService';
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
  const live = new StudioLiveService({
    sessions,
    workspaces,
    attachments: deps.attachments,
    roots: id => deps.service.studioContextRoots(id),
    prepare: (...args) => deps.service.prepareStudioText(...args),
    available: () => !!auth.getApiClient(),
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
        const model = (await deps.models.listImageModels())[0];
        if (!model) throw new Error('No image models are available.');
        return { kind: 'image', body: { prompt, model, ...(settings.size ? { size: settings.size } : {}) } };
      }
      case 'video': {
        const model = resolveVideoModel(await deps.models.listVideoModels(), undefined);
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
        const model = pool.find(model => !model.preview) ?? pool[0];
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
  async function indexChatSession(sessionId: string) {
    if (!auth.getApiClient()) return;
    const scope = sessions.scopeKey();
    const session = await sessions.get(sessionId);
    if (!session || scope !== sessions.scopeKey()) return;
    const key = `${scope}:${sessionId}`;
    if (indexed.get(key) === session.updatedAt) return;
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
    for (const candidate of (await sessions.list()).slice(0, 256)) {
      if (scope !== sessions.scopeKey()) throw new Error('Account changed.');
      if (
        candidate.id === sessionId ||
        (await sessions.resolveStudioWorkspace(candidate.id, scope))?.workspaceId === workspace.workspaceId
      )
        await indexChatSession(candidate.id);
    }
    return live.get(sessionId);
  });
  ipc.handle(IPC_CHANNELS.studioPrepare, (_event, draft: unknown) => live.prepare(draft));
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
    if (request.action === 'rename') {
      if (!request.title) throw new Error('Title is required.');
      await generation.renameAsset(request.sessionId, request.assetId, request.title);
    } else if (request.action === 'delete') {
      await generation.removeAsset(request.sessionId, request.assetId);
    } else {
      const file = await generation.locateAsset(request.sessionId, request.assetId);
      if (!file) throw new Error('Local asset is unavailable.');
      if (scope !== sessions.scopeKey()) throw new Error('Account changed.');
      if (request.action === 'preview') await shell.openPath(file.path);
      if (request.action === 'export') {
        const picked = await dialog.showSaveDialog({
          defaultPath: join(app.getPath('downloads'), basename(file.path)),
        });
        if (scope !== sessions.scopeKey()) throw new Error('Account changed.');
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
    }
  }, 500);
  let lastScope = sessions.scopeKey();
  timer.unref();
  const dispose = () => {
    clearInterval(timer);
    live.invalidate();
    authorizations.clear();
    indexed.clear();
  };
  app.once('before-quit', dispose);
  return { live, generation, dispose, indexChatSession };
}

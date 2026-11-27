import { app, dialog, shell, type IpcMain } from 'electron';
import { copyFile, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { IPC_CHANNELS } from '@shared/ipc';
import { studioIdSchema } from '@shared/studio';
import { studioAssetActionSchema, type StudioCatalog } from '@shared/studioIpc';
import type { AuthLogger } from '@bike4mind/client-auth';
import { createStudioSessionDeletion } from './StudioSessionDeletion';
import { createStudioDiagnostics } from './StudioDiagnostics';
import type { AuthService } from '../../auth/AuthService';
import type { SessionStore } from '../SessionStore';
import type { ChatService } from '../ChatService';
import type { AttachmentStore } from '../AttachmentStore';
import type { MediaStore } from '../media/MediaStore';
import type { ModelCatalog } from '../ModelCatalog';
import type { ChatVideoJob } from '@shared/chat';
import { MediaApiClient } from '../media/MediaApiClient';
import { readStudioCatalog } from './StudioCatalog';
import { planStudioCreation } from './StudioPlan';
import { StudioWorkspaceStore } from './StudioWorkspaceStore';
import { StudioLiveService } from './StudioLiveService';
import { StudioJobScheduler } from './StudioJobScheduler';
import { StudioGenerationService, studioGenerationRequestSchema } from './generation/StudioGenerationService';

export function registerStudio(deps: {
  logger: Pick<AuthLogger, 'warn'>;
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
  let disposed = false;
  const diagnostic = createStudioDiagnostics(deps.logger);
  const workspaces = new StudioWorkspaceStore(join(deps.directory, 'studio'), sessions);
  const generation = new StudioGenerationService({
    workspaces,
    diagnostic,
    media: deps.media,
    connection: () => {
      if (disposed) return null;
      const scope = sessions.scopeKey();
      const api = auth.getSessionBoundApiClient();
      return scope && api ? { scope, client: new MediaApiClient(api) } : null;
    },
    authorize: async () => false,
  });
  let availability: { scope: string | null; expires: number; catalog: StudioCatalog } | undefined;
  const catalog = async (): Promise<StudioCatalog> => {
    const scope = sessions.scopeKey();
    const api = auth.getSessionBoundApiClient();
    if (!api) return { images: [], videos: [], music: [], speech: [], soundEffects: [], voices: [] };
    if (availability?.scope === scope && availability.expires > Date.now()) return availability.catalog;
    const value = await readStudioCatalog(api, deps.models);
    if (scope !== sessions.scopeKey() || api !== auth.getSessionBoundApiClient()) throw new Error('Account changed.');
    availability = { scope, expires: Date.now() + 60_000, catalog: value };
    return value;
  };
  const live = new StudioLiveService({
    sessions,
    workspaces,
    attachments: deps.attachments,
    roots: id => deps.service.studioContextRoots(id),
    prepare: (...args) => deps.service.prepareStudioText(...args, auth.getSessionBoundApiClient()),
    available: () => !!auth.getSessionBoundApiClient(),
    catalog,
    plan: async (draft, prompt) => planStudioCreation(draft, prompt, await catalog()),
    unavailableKinds: async () => {
      const value = await catalog();
      return [
        ...(!value.images.length ? ['image'] : []),
        ...(!value.videos.length ? ['video'] : []),
        ...(!value.music.length ? ['music'] : []),
        ...(!value.speech.length ? ['speech'] : []),
        ...(!value.soundEffects.length ? ['sound-effect'] : []),
      ];
    },
    changed: deps.changed,
    generation: {
      recover: id => (auth.getSessionBoundApiClient() ? generation.recover(id) : Promise.resolve([])),
      submit: async (sessionId, draft, prompt, provenance, authorize, planned) => {
        const scope = sessions.scopeKey();
        if (!planned) throw new Error('Prepare and review these settings first.');
        const body = { ...planned.body, ...('text' in planned.body ? { text: prompt } : { prompt }) };
        const request = {
          ...studioGenerationRequestSchema.parse({ ...planned, body }),
          provenance,
          selection: draft.selection,
        };
        const checked = planStudioCreation(draft, prompt, await catalog()).request;
        if (
          JSON.stringify(studioGenerationRequestSchema.parse({ ...planned, body })) !==
          JSON.stringify(studioGenerationRequestSchema.parse(checked))
        )
          throw new Error('Model capabilities changed. Review again.');
        const api = auth.getSessionBoundApiClient();
        if (!api) throw new Error('Sign in first.');
        for (const reference of draft.settings.references ?? []) {
          const file = await new MediaApiClient(api).getFile(reference.fileId);
          if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.mime_type))
            throw new Error('Reference images must be PNG, JPEG, or WebP.');
          if (file.moderation_status !== 'clean' || !file.download_url)
            throw new Error('Reference image is not ready. Wait for the file scan, then review again.');
          if (scope !== sessions.scopeKey()) throw new Error('Account changed.');
        }
        if (scope !== sessions.scopeKey()) throw new Error('Account changed.');
        const expected = JSON.stringify(request);
        let authorizationUsed = false;
        return generation.submit(sessionId, request, async authorization => {
          if (authorizationUsed) return false;
          authorizationUsed = true;
          if (
            scope !== sessions.scopeKey() ||
            authorization.sessionId !== sessionId ||
            JSON.stringify(authorization.request) !== expected
          )
            return false;
          return authorize();
        });
      },
    },
  });
  const indexed = new Map<string, string>();
  const indexedFamilies = new Set<string>();
  async function indexChatSession(sessionId: string, force = false) {
    if (!auth.getSessionBoundApiClient()) return;
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
  ipc.handle(IPC_CHANNELS.studioUploadReference, async (_event, raw: unknown) => {
    const sessionId = studioIdSchema.parse(raw);
    const scope = sessions.scopeKey();
    const api = auth.getSessionBoundApiClient();
    if (!api || !(await sessions.get(sessionId))) throw new Error('Sign in and open a session first.');
    const picked = await dialog.showOpenDialog({
      title: 'Upload reference image to Files',
      buttonLabel: 'Upload image',
      message: 'The selected image is uploaded to your account.',
      properties: ['openFile'],
      filters: [{ name: 'Reference image', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    if (picked.canceled || !picked.filePaths[0]) return null;
    if (scope !== sessions.scopeKey()) throw new Error('Account changed.');
    // The native-dialog pick is the user's consent, so this upload is not checked against folder grants
    // (those scope the agent, in any session). O_NOFOLLOW still refuses a symlink swapped in after the pick.
    const path = await realpath(picked.filePaths[0]);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size < 1 || info.size > 20 * 1024 * 1024)
        throw new Error('Choose an image up to 20 MB.');
      bytes = Buffer.alloc(info.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await file.read(bytes, length, bytes.length - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length !== info.size) throw new Error('The image changed. Select it again.');
      bytes = bytes.subarray(0, length);
    } finally {
      await file.close();
    }
    if (scope !== sessions.scopeKey() || !(await sessions.get(sessionId))) throw new Error('Session changed.');
    const mime =
      bytes[0] === 0x89 && bytes.subarray(1, 4).toString() === 'PNG'
        ? 'image/png'
        : bytes[0] === 0xff && bytes[1] === 0xd8
          ? 'image/jpeg'
          : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
            ? 'image/webp'
            : null;
    if (!mime) throw new Error('Choose a PNG, JPEG, or WebP image.');
    const uploaded = await new MediaApiClient(api).uploadFile(basename(path), mime, bytes);
    if (scope !== sessions.scopeKey()) throw new Error('Account changed.');
    return { fileId: uploaded.id, name: basename(path) };
  });
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
      indexed.clear();
      indexedFamilies.clear();
      availability = undefined;
    }
  }, 500);
  let lastScope = sessions.scopeKey();
  timer.unref();
  const scheduler = new StudioJobScheduler({
    diagnostic,
    scope: () => (auth.getSessionBoundApiClient() ? sessions.scopeKey() : null),
    sessions: async () => {
      const scope = sessions.scopeKey();
      const listed = await sessions.list();
      if (scope !== sessions.scopeKey()) return [];
      if (Date.now() >= nextCleanup) {
        nextCleanup = Date.now() + 60 * 60_000;
        const active = new Set<string>();
        let complete = true;
        for (const session of listed) {
          try {
            const identity = session.studioWorkspaceId
              ? { workspaceId: session.studioWorkspaceId }
              : await sessions.resolveStudioWorkspace(session.id, scope);
            if (scope !== sessions.scopeKey()) return [];
            if (identity) active.add(identity.workspaceId);
          } catch {
            if (scope !== sessions.scopeKey()) return [];
            complete = false;
            diagnostic('scheduler-workspace', { sessionId: session.id });
          }
        }
        if (complete && scope === sessions.scopeKey()) {
          try {
            await generation.pruneOrphans(active);
          } catch {
            if (scope !== sessions.scopeKey()) return [];
            diagnostic('workspace-cleanup', {});
            complete = false;
          }
        }
        if (!complete) nextCleanup = Date.now() + 60_000;
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
    disposed = true;
    scheduler.dispose();
    clearInterval(timer);
    live.invalidate();
    indexed.clear();
    indexedFamilies.clear();
  };
  app.once('before-quit', dispose);
  return {
    live,
    generation,
    dispose,
    indexChatSession,
    withSessionDeletion: createStudioSessionDeletion(sessions, live, generation),
  };
}
